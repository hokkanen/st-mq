import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { createConnection } from 'node:net';
import { pairError } from './state.js';

export function validateVip(value) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value.interface ?? '') ||
      isIP(value.address) !== 4 || !Number.isInteger(value.prefixLength) || value.prefixLength < 1 || value.prefixLength > 32 ||
      /^(0|127|169\.254|22[4-9]|23\d|24\d|25[0-5])\./.test(value.address)) throw pairError('vip_failed');
  return value;
}

export function runVipCommand(command, args, { spawnProcess = spawn, timeoutMs = 10000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.on('data', data => {
      output += data.toString();
      if (output.length > 65536) { child.kill('SIGKILL'); reject(pairError('vip_failed')); }
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(pairError('vip_failed')); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(pairError('vip_failed')); });
    child.once('close', status => { clearTimeout(timer); status === 0 ? accept(output) : reject(pairError('vip_failed')); });
  });
}

export function requestVipSocket(socketPath, args) {
  return new Promise((accept, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = '';
    socket.setTimeout(10000, () => socket.destroy(pairError('vip_failed')));
    socket.once('connect', () => socket.write(`${JSON.stringify(args)}\n`));
    socket.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 256) socket.destroy(pairError('vip_failed'));
      else if (buffer.includes('\n')) {
        socket.end();
        if (buffer.trim() === 'ok') accept(); else reject(pairError('vip_failed'));
      }
    });
    socket.once('error', () => reject(pairError('vip_failed')));
    socket.once('close', () => { if (!buffer.includes('\n')) reject(pairError('vip_failed')); });
  });
}

/** Privileged operations are a fixed argv protocol; no peer value reaches a shell. */
export class VirtualIP {
  constructor(config, { run = runVipCommand } = {}) {
    this.config = validateVip(config);
    this.run = run;
    this.owned = false;
    this.error = null;
    this.pending = Promise.resolve();
  }
  change(action) {
    const task = this.pending.then(() => this.perform(action));
    this.pending = task.catch(() => {});
    return task;
  }
  async perform(action) {
    try {
      const args = [action, this.config.interface, this.config.address, String(this.config.prefixLength)];
      if (this.config.socketPath) await requestVipSocket(this.config.socketPath, args);
      else if (this.config.sudo) await this.run('sudo', ['-n', this.config.helperPath, ...args]);
      else await this.run(this.config.helperPath, args);
      this.owned = action === 'acquire';
      this.error = null;
    } catch { this.error = 'vip_failed'; throw pairError('vip_failed'); }
  }
  acquire() { return this.change('acquire'); }
  release() { return this.change('release'); }
  status() { return { owned: this.owned, ready: this.owned && !this.error, error: this.error }; }
}
