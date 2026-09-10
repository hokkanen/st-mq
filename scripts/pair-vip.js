#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { validateVip, runVipCommand } from '../src/pairing/vip.js';

/** Root-owned policy permits exactly one configured interface/address. */
export async function manageVip(args, { policyPath = '/etc/st-mq-vip/policy.json',
  run = runVipCommand, requireRootPolicy = true } = {}) {
  const [action, networkInterface, address, prefix] = args;
  if (args.length !== 4 || !['acquire', 'release'].includes(action)) throw Error('vip_failed');
  const wanted = validateVip({ interface: networkInterface, address, prefixLength: Number(prefix) });
  const info = await lstat(policyPath);
  if (!info.isFile() || info.isSymbolicLink() || (requireRootPolicy && (info.uid !== 0 || (info.mode & 0o022)))) throw Error('vip_failed');
  const policy = validateVip(JSON.parse(await readFile(policyPath, 'utf8')));
  if (policy.interface !== wanted.interface || policy.address !== wanted.address || policy.prefixLength !== wanted.prefixLength) throw Error('vip_failed');
  const cidr = `${wanted.address}/${wanted.prefixLength}`;
  if (action === 'acquire') {
    await run('ip', ['address', 'replace', cidr, 'dev', wanted.interface]);
    try { await run('arping', ['-U', '-c', '3', '-I', wanted.interface, wanted.address]); }
    catch {
      // An address without an announced ownership transition is not ready.
      await run('ip', ['address', 'del', cidr, 'dev', wanted.interface]).catch(() => {});
      throw Error('vip_failed');
    }
  } else {
    const present = async () => {
      const output = await run('ip', ['-j', 'address', 'show', 'dev', wanted.interface]);
      return JSON.parse(output).some(item => item.addr_info?.some(address =>
        address.local === wanted.address && address.prefixlen === wanted.prefixLength));
    };
    // Absence is idempotent; permission or command failures are not success.
    if (await present()) await run('ip', ['address', 'del', cidr, 'dev', wanted.interface]);
    if (await present()) throw Error('vip_failed');
  }
}

export function serveVip({ fd = 3, socketPath, manage = manageVip } = {}) {
  let pending = Promise.resolve();
  const server = createServer(socket => {
    let buffer = '', handled = false;
    socket.setTimeout(12000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', data => {
      if (handled) return;
      buffer += data.toString();
      if (buffer.length > 512) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      handled = true;
      let args;
      try { args = JSON.parse(buffer.trim()); if (!Array.isArray(args) || args.length !== 4) throw Error(); }
      catch { socket.end('error\n'); return; }
      const job = pending.then(() => manage(args));
      pending = job.catch(() => {});
      job.then(() => socket.end('ok\n'), () => socket.end('error\n'));
    });
  });
  server.listen(socketPath ? { path: socketPath } : { fd });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--serve' && Number(process.env.LISTEN_PID) === process.pid && process.env.LISTEN_FDS === '1') {
    serveVip().on('error', () => { process.stderr.write('VIP helper unavailable.\n'); process.exitCode = 1; });
  } else manageVip(process.argv.slice(2)).catch(() => { process.stderr.write('VIP operation failed.\n'); process.exitCode = 1; });
}
