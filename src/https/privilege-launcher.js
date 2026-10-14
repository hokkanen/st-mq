// Trusted application source, never downloaded. The existing platform setpriv
// sets NoNewPrivs before this Node process loads. Child code is already vendor
// authenticated and opened by the parent as fd3, never copied to a writable
// helper directory. fd4 is a private control channel to the owning application.
import { spawn } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';

const [uidText, gidText, rootText, ...args] = process.argv.slice(2);
const uid = Number(uidText); const gid = Number(gidText); const root = rootText === 'root';
function prove(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const get = field => new RegExp(`^${field}:[ \\t]*(.*)$`, 'm').exec(status)?.[1]?.trim();
  if (uid === 0 || !get('Uid')?.split(/\s+/).every(value => Number(value) === uid) || !get('Gid')?.split(/\s+/).every(value => Number(value) === gid) ||
      !['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].every(field => /^0+$/.test(get(field) ?? '')) || get('NoNewPrivs') !== '1' || root && get('Groups')?.trim()) throw Error('privilege_check_failed');
}
let child;
let stopping = false;
function stop(signal = 'SIGTERM') {
  if (!child || stopping) return; stopping = true;
  child.kill(signal); setTimeout(() => child.kill('SIGKILL'), 4000).unref();
}
try {
  if (root) { process.setgroups([]); process.setgid(gid); process.setuid(uid); }
  prove(process.pid);
  child = spawn('/proc/self/fd/3', args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit', 3] });
  child.once('spawn', () => {
    // A short version/help command may finish before /proc can be read under
    // ARM emulation. The launcher has already proved its effective restrictions;
    // exec inherits them with NoNewPrivs. Foreground daemon proof is checked
    // independently against the actual child by the owning application.
    try { writeSync(4, `${JSON.stringify({ pid: child.pid, privilegeVerified: true })}\n`); }
    catch { child.kill('SIGKILL'); process.exitCode = 1; }
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal));
  // The fd4 parent pipe also furnishes crash detection: an application death
  // closes the pipe; stop only this launcher's owned foreground child.
  // Node creates extra stdio pipes as local socket pairs on Linux. Native
  // socket monitoring keeps EOF asynchronous; fsReadStream could block a worker
  // in read(2), including while a fast CLI command tries to exit under QEMU.
  const control = new Socket({ fd: 4, readable: true, writable: true });
  control.on('end', () => stop()); control.on('error', () => stop());
  control.resume();
  child.once('error', () => process.exit(1));
  child.once('exit', (code, signal) => { control.destroy(); process.exit(code ?? (signal ? 1 : 0)); });
} catch { if (child) child.kill('SIGKILL'); process.exit(1); }
