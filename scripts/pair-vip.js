#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { validateVip, runVipCommand, VIP_ERRORS } from '../src/pairing/vip.js';

const failed = code => Object.assign(new Error(code), { code });
const publicFailure = error => VIP_ERRORS.has(error?.code) ? error.code : 'vip_failed';

/** Root-owned policy permits exactly one configured interface/address. */
export async function manageVip(args, { policyPath = '/etc/st-mq-vip/policy.json',
  run = runVipCommand, requireRootPolicy = true, interfaces = networkInterfaces } = {}) {
  const [action, networkInterface, address, prefix] = args;
  if (args.length !== 4 || !['acquire', 'release'].includes(action)) throw Error('vip_failed');
  const wanted = validateVip({ interface: networkInterface, address, prefixLength: Number(prefix) });
  let policy;
  try {
    const info = await lstat(policyPath);
    if (!info.isFile() || info.isSymbolicLink() || (requireRootPolicy && (info.uid !== 0 || (info.mode & 0o022)))) throw Error();
    policy = validateVip(JSON.parse(await readFile(policyPath, 'utf8')));
  } catch { throw failed('vip_policy_invalid'); }
  if (policy.interface !== wanted.interface || policy.address !== wanted.address || policy.prefixLength !== wanted.prefixLength)
    throw failed('vip_policy_mismatch');
  if (!Object.hasOwn(interfaces(), wanted.interface)) throw failed('vip_interface_missing');
  const cidr = `${wanted.address}/${wanted.prefixLength}`;
  if (action === 'acquire') {
    try { await run('ip', ['address', 'replace', cidr, 'dev', wanted.interface]); }
    catch { throw failed('vip_command_failed'); }
    try { await run('arping', ['-U', '-c', '3', '-I', wanted.interface, wanted.address]); }
    catch {
      // An address without an announced ownership transition is not ready.
      try { await run('ip', ['address', 'del', cidr, 'dev', wanted.interface]); }
      catch { throw failed('vip_release_failed'); }
      throw failed('vip_announce_failed');
    }
  } else {
    const present = async () => {
      const output = await run('ip', ['-j', 'address', 'show', 'dev', wanted.interface]);
      return JSON.parse(output).some(item => item.addr_info?.some(address =>
        address.local === wanted.address && address.prefixlen === wanted.prefixLength));
    };
    // Absence is idempotent; permission or command failures are not success.
    try {
      if (await present()) await run('ip', ['address', 'del', cidr, 'dev', wanted.interface]);
      if (await present()) throw Error();
    } catch { throw failed('vip_release_failed'); }
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
      job.then(() => socket.end('ok\n'), error => socket.end(`error:${publicFailure(error)}\n`));
    });
  });
  server.listen(socketPath ? { path: socketPath } : { fd });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--serve' && Number(process.env.LISTEN_PID) === process.pid && process.env.LISTEN_FDS === '1') {
    serveVip().on('error', () => { process.stderr.write('VIP helper unavailable.\n'); process.exitCode = 1; });
  } else manageVip(process.argv.slice(2)).catch(error => {
    process.stdout.write(`error:${publicFailure(error)}\n`);
    process.stderr.write('VIP operation failed.\n'); process.exitCode = 1;
  });
}
