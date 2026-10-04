import { spawn } from 'node:child_process';

// Only fixed, local messages belong in this error type; callers may display it.
export class DeploymentTransportError extends Error {}

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SSH_DESTINATION = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:.]+\]|[A-Fa-f0-9]*:[A-Fa-f0-9:.]+)$/;
const SSH_OPTIONS = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ForkAfterAuthentication=no',
  '-o', 'StdinNull=no',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ControlMaster=no',
  '-o', 'ControlPath=none',
];

export function validateSSHHost(ssh_host) {
  if (typeof ssh_host !== 'string' || ssh_host.length > 255 || !SSH_DESTINATION.test(ssh_host)) {
    throw new DeploymentTransportError('Invalid SSH destination; use an SSH config alias or user@host');
  }
  return ssh_host;
}

// OpenSSH owns keys, aliases and known_hosts. Every logical operation gets one
// foreground process; binary stdin stays separate from the remote shell command.
// Uncertain execution poisons the transport instead of reconnecting/replaying.
export async function connectSSH({ ssh_host } = {}, { spawnProcess = spawn } = {}) {
  validateSSHHost(ssh_host);
  let active = null;
  let failure = null;
  const poison = message => failure ??= new DeploymentTransportError(message);

  return {
    async close() {
      poison(active ? 'SSH transport closed; the remote operation may still be running' : 'SSH transport is closed');
      if (active) {
        const job = active;
        job.stop(failure);
        await job.completion.catch(() => {});
      }
    },
    run(script, { input, timeoutMs = 30000 } = {}) {
      if (failure) return Promise.reject(failure);
      if (active) return Promise.reject(new DeploymentTransportError('An SSH command is already running'));
      if (typeof script !== 'string' || script.includes('\0') || (input !== undefined && !Buffer.isBuffer(input)) ||
          !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
        return Promise.reject(new DeploymentTransportError('Invalid SSH command, input or timeout'));
      }
      let resolve, reject;
      const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
      let child, commandTimer, killTimer, settled = false;
      let outputBytes = 0;
      const output = [];
      const finish = (error, exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(commandTimer);
        clearTimeout(killTimer);
        active = null;
        if (error) reject(error);
        else resolve({ exitCode, output: Buffer.concat(output).toString('utf8') });
      };
      const stop = error => {
        if (settled) return;
        failure ??= error;
        clearTimeout(commandTimer);
        if (!child) { finish(failure); return; }
        if (killTimer) return;
        // Reap the local client before resolving. Killing it cannot establish
        // whether a remote command, especially a Supervisor rebuild, stopped.
        try { child.kill('SIGTERM'); } catch { /* Never expose process details. */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* Wait for close below. */ }
        }, 1000);
      };
      active = { completion, stop };
      try {
        child = spawnProcess('ssh', [...SSH_OPTIONS, '--', ssh_host, `sh -c ${shellQuote(script)}`], {
          stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        });
      } catch {
        stop(poison('SSH process could not start'));
        return completion;
      }
      const capture = (chunk, keep) => {
        if (settled || failure) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          stop(poison('SSH output exceeded its limit; the remote operation may still be running'));
          return;
        }
        if (keep) output.push(Buffer.from(chunk));
      };
      child.stdout.on('data', chunk => capture(chunk, true));
      child.stderr.on('data', chunk => capture(chunk, false));
      child.stdout.on('error', () => stop(poison('SSH output failed; remote completion is unconfirmed')));
      child.stderr.on('error', () => stop(poison('SSH output failed; remote completion is unconfirmed')));
      child.stdin.on('error', () => stop(poison('SSH input failed; remote completion is unconfirmed')));
      child.on('error', () => stop(poison('SSH process failed; remote completion is unconfirmed')));
      child.once('close', (code, signal) => {
        if (failure) { finish(failure); return; }
        if (signal || code === null || code === 255) {
          finish(poison('SSH connection failed; the remote operation may still be running. Inspect HA before retrying'));
          return;
        }
        finish(null, code);
      });
      commandTimer = setTimeout(() => {
        stop(poison('SSH command timed out; the remote operation may still be running. Inspect HA before retrying'));
      }, timeoutMs);
      try { child.stdin.end(input); }
      catch { stop(poison('SSH input failed; remote completion is unconfirmed')); }
      return completion;
    },
  };
}
