import { openSync, readSync, closeSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { networkInterfaces as systemNetworkInterfaces } from 'node:os';

const MAX_ROUTE_BYTES = 64 * 1024;
// Keep ordinary Ethernet/Wi-Fi, bonds and LAN bridges eligible. These names
// identify common container and tunnel interfaces, not charger-facing LANs.
const NON_LAN_INTERFACE = /^(?:lo(?:\d|$)|docker|veth|virbr|podman|cni|flannel|cali|kube|tun|tap|utun|wg|vpn|tailscale|zerotier|zt[a-z0-9]+|ppp|ipsec|br-[a-f0-9]{12}(?:$|:))/i;

function readSystemRoutes() {
  const buffer = Buffer.alloc(MAX_ROUTE_BYTES + 1);
  let fd;
  try {
    fd = openSync('/proc/net/route', 'r');
    let length = 0, count;
    do {
      count = readSync(fd, buffer, length, buffer.length - length, null);
      length += count;
    } while (count && length < buffer.length);
    return length > MAX_ROUTE_BYTES ? null : buffer.toString('utf8', 0, length);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function usableIpv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254);
}

function defaultRoutes(text) {
  if (typeof text !== 'string' || text.length > MAX_ROUTE_BYTES) return null;
  const lines = text.trim().split(/\r?\n/);
  if (!/^Iface\s+Destination\s+Gateway\s+Flags\s+RefCnt\s+Use\s+Metric\s+Mask\b/.test(lines.shift())) return null;
  const routes = [];
  for (const line of lines) {
    const [iface, destination, , flags, , , metric, mask] = line.trim().split(/\s+/);
    if (destination !== '00000000' || mask !== '00000000' || !/^[a-f0-9]{1,8}$/i.test(flags)
      || !/^\d+$/.test(metric) || !Number.isSafeInteger(Number(metric))) continue;
    const bits = Number.parseInt(flags, 16);
    if (!(bits & 1) || bits & 0x200) continue; // Route is up and not a reject route.
    routes.push({ iface, metric: Number(metric) });
  }
  return routes;
}

/** Select a local IPv4 candidate, without probing or claiming charger reachability.
 * A specific bind host must exist on an eligible interface. Wildcard listeners
 * prefer Linux's lowest-metric LAN default route; unavailable route information
 * permits only a single candidate address. Ambiguity requires an explicit URL.
 * Injectable OS readers keep tests independent of the developer's network. */
export function detectLocalOcppAddress({ host = '0.0.0.0', networkInterfaces = systemNetworkInterfaces,
  platform = process.platform, readRoutes = readSystemRoutes } = {}) {
  let interfaces;
  try { interfaces = networkInterfaces(); } catch { return ''; }
  const candidates = new Map();
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    if (NON_LAN_INTERFACE.test(name) || !Array.isArray(entries)) continue;
    const addresses = new Set(entries.filter(entry => entry && !entry.internal
      && entry.family === 'IPv4' && usableIpv4(entry.address)).map(entry => entry.address));
    if (addresses.size) candidates.set(name, addresses);
  }
  const uniqueAddress = sets => {
    const addresses = new Set(sets.flatMap(set => [...set]));
    return addresses.size === 1 ? [...addresses][0] : '';
  };
  if (!['0.0.0.0', '::'].includes(host))
    return usableIpv4(host) && [...candidates.values()].some(addresses => addresses.has(host)) ? host : '';
  if (!candidates.size) return '';
  let routes = null;
  if (platform === 'linux') {
    try { routes = defaultRoutes(readRoutes()); } catch { /* An unreadable route table is unavailable evidence. */ }
  }
  if (routes === null) return uniqueAddress([...candidates.values()]);
  const lanRoutes = routes.filter(route => candidates.has(route.iface));
  if (!lanRoutes.length) return '';
  const metric = Math.min(...lanRoutes.map(route => route.metric));
  const preferred = new Set(lanRoutes.filter(route => route.metric === metric).map(route => route.iface));
  if (preferred.size !== 1) return '';
  return uniqueAddress([candidates.get([...preferred][0])]);
}
