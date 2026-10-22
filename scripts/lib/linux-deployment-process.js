// Tie authenticated HTTP evidence to systemd's actual application process.
// Linux /proc reads only: no application imports, signals or device operations.
import { readFileSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

try {
  const [pid, node, current, origin] = process.argv.slice(2);
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error();
  const proc = `/proc/${pid}`, url = new URL(origin), port = Number(url.port || 80);
  if (realpathSync(join(proc, 'cwd')) !== realpathSync(current) || realpathSync(join(proc, 'exe')) !== realpathSync(node)) throw new Error();
  const command = readFileSync(join(proc, 'cmdline')).toString().split('\0').filter(Boolean);
  if (command.length !== 2 || command[1] !== join(current, 'src/main.js')) throw new Error();
  const sockets = new Set();
  for (const file of readdirSync(join(proc, 'fd'))) {
    try { const m = /^socket:\[([0-9]+)\]$/.exec(readlinkSync(join(proc, 'fd', file))); if (m) sockets.add(m[1]); } catch { /* A descriptor can close during observation. */ }
  }
  const ipv6 = url.hostname === '[::1]';
  const addresses = ipv6 ? ['00000000000000000000000000000000', '00000000000000000000000001000000'] : ['00000000', '0100007F'];
  const owned = readFileSync(join(proc, 'net', ipv6 ? 'tcp6' : 'tcp'), 'utf8').split('\n').slice(1).some(line => {
    const fields = line.trim().split(/\s+/), [address, hexPort] = (fields[1] ?? '').split(':');
    return fields[3] === '0A' && addresses.includes(address) && parseInt(hexPort, 16) === port && sockets.has(fields[9]);
  });
  if (!owned) throw new Error();
} catch {
  console.error('The configured status listener is not owned by the expected application service process.');
  process.exitCode = 1;
}
