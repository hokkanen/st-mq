// Also serialized into the HA container probe. Keep this function self-contained.
export function ownsApplicationListener({ pid, executable, directory, entrypoint, origin }, fs) {
  if (!/^[1-9][0-9]*$/.test(String(pid))) throw new Error('Invalid process identity.');
  const proc = `/proc/${pid}`, url = new URL(origin), port = Number(url.port || 80);
  if (fs.realpathSync(`${proc}/cwd`) !== fs.realpathSync(directory)
    || fs.realpathSync(`${proc}/exe`) !== fs.realpathSync(executable)) throw new Error('Unexpected application process.');
  const command = fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean);
  const entry = command[1]?.startsWith('/') ? command[1] : `${directory}/${command[1]}`;
  if (command.length !== 2 || fs.realpathSync(entry) !== fs.realpathSync(entrypoint)) throw new Error('Unexpected application entrypoint.');
  const sockets = new Set();
  for (const file of fs.readdirSync(`${proc}/fd`)) {
    try { const m = /^socket:\[([0-9]+)\]$/.exec(fs.readlinkSync(`${proc}/fd/${file}`)); if (m) sockets.add(m[1]); } catch { /* Descriptor closed during observation. */ }
  }
  const ipv6 = url.hostname === '[::1]';
  const addresses = ipv6 ? ['00000000000000000000000000000000', '00000000000000000000000001000000'] : ['00000000', '0100007F'];
  return fs.readFileSync(`${proc}/net/${ipv6 ? 'tcp6' : 'tcp'}`, 'utf8').split('\n').slice(1).some(line => {
    const fields = line.trim().split(/\s+/), [address, hexPort] = (fields[1] ?? '').split(':');
    return fields[3] === '0A' && addresses.includes(address) && parseInt(hexPort, 16) === port && sockets.has(fields[9]);
  });
}
