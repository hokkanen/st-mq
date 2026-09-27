import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLocalOcppAddress } from '../src/acquisition/local-ocpp-address.js';

const ipv4 = address => ({ address, family: 'IPv4', internal: false });
const header = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT';
const route = (iface, metric = 100, { destination = '00000000', mask = '00000000', flags = '0003' } = {}) =>
  `${iface}\t${destination}\t010200C0\t${flags}\t0\t0\t${metric}\t${mask}\t0\t0\t0`;
function detect(interfaces, routes, options = {}) {
  return detectLocalOcppAddress({ platform: 'linux', networkInterfaces: () => interfaces,
    readRoutes: () => routes === undefined ? null : [header, ...routes].join('\n'), ...options });
}

test('LAN address selection follows the lowest-metric default route', () => {
  const interfaces = { eth0: [ipv4('192.0.2.10')], wlan0: [ipv4('198.51.100.10')] };
  assert.equal(detect(interfaces, [route('wlan0', 600), route('eth0', 100)]), '192.0.2.10');
  assert.equal(detect(interfaces, [route('eth0', 800), route('wlan0', 200)]), '198.51.100.10');
  assert.equal(detect(interfaces, [route('wlan0', 100), route('eth0', 100)]), '');
  assert.equal(detect(interfaces, [route('eth0', 100), route('eth0', 100)]), '192.0.2.10');
});

test('container and VPN default routes do not replace a usable LAN route', () => {
  for (const iface of ['docker0', 'veth1234', 'virbr0', 'br-123456abcdef', 'podman0', 'cni0',
    'flannel.1', 'cali1234', 'kube-ipvs0', 'tun0', 'tun-office', 'tap0', 'utun4', 'wg0', 'wg-office',
    'vpn0', 'tailscale0', 'zt1234', 'ppp0', 'ipsec0']) {
    const interfaces = { eth0: [ipv4('192.0.2.10')], [iface]: [ipv4('198.51.100.20')] };
    assert.equal(detect(interfaces, [route(iface, 1), route('eth0', 100)]), '192.0.2.10', iface);
    assert.equal(detect({ [iface]: interfaces[iface] }, undefined), '', iface);
  }
  assert.equal(detect({ br0: [ipv4('192.0.2.10')] }, [route('br0')]), '192.0.2.10', 'A LAN bridge remains eligible');
});

test('loopback, link-local, wildcard, multicast, invalid and IPv6 addresses are ineligible', () => {
  for (const address of ['0.0.0.0', '0.1.2.3', '127.0.0.1', '169.254.10.20', '224.0.0.1',
    '239.1.2.3', '255.255.255.255', '192.0.2.999', '192.0.2.01', '::1'])
    assert.equal(detect({ eth0: [ipv4(address)] }, [route('eth0')]), '', address);
  assert.equal(detect({ eth0: [{ ...ipv4('192.0.2.10'), internal: true }] }, [route('eth0')]), '');
  assert.equal(detect({ eth0: [{ address: '2001:db8::10', family: 'IPv6', internal: false }] }, [route('eth0')]), '');
  assert.equal(detect({ lo: [ipv4('192.0.2.10')] }, [route('lo')]), '');
});

test('several addresses on the preferred interface require an explicit selection', () => {
  const interfaces = { eth0: [ipv4('192.0.2.10'), ipv4('192.0.2.11')], wlan0: [ipv4('198.51.100.10')] };
  assert.equal(detect(interfaces, [route('eth0', 100), route('wlan0', 200)]), '');
  assert.equal(detect(interfaces, undefined), '');
  assert.equal(detect(interfaces, undefined, { host: '192.0.2.11' }), '192.0.2.11');
});

test('a specific bind host must be present on an eligible local interface', () => {
  const interfaces = { eth0: [ipv4('192.0.2.10')], wlan0: [ipv4('198.51.100.10')], tun0: [ipv4('203.0.113.10')] };
  const readRoutes = () => { assert.fail('A specific bind host needs no route lookup'); };
  assert.equal(detect(interfaces, [], { host: '198.51.100.10', readRoutes }), '198.51.100.10');
  for (const host of ['192.0.2.99', '203.0.113.10', '127.0.0.1', 'localhost', '2001:db8::10'])
    assert.equal(detect(interfaces, [], { host, readRoutes }), '', host);
  assert.equal(detect({ eth0: interfaces.eth0 }, [route('eth0')], { host: '::' }), '192.0.2.10');
});

test('unavailable route information permits only one usable address', () => {
  const one = { eth0: [ipv4('192.0.2.10')] }, two = { ...one, wlan0: [ipv4('198.51.100.10')] };
  for (const options of [
    {},
    { readRoutes: () => { throw new Error('fixture-unavailable'); } },
    { readRoutes: () => 'malformed route data' },
    { platform: 'darwin', readRoutes: () => { assert.fail('Non-Linux detection does not read proc'); } },
  ]) {
    assert.equal(detect(one, undefined, options), '192.0.2.10');
    assert.equal(detect(two, undefined, options), '');
  }
  assert.equal(detect({}, undefined), '');
  assert.equal(detect(one, undefined, { networkInterfaces: () => { throw new Error('fixture-unavailable'); } }), '');
});

test('available Linux routing evidence must include an active non-reject LAN default route', () => {
  const interfaces = { eth0: [ipv4('192.0.2.10')] };
  for (const routes of [[], [route('eth1')], [route('eth0', 100, { flags: '0000' })],
    [route('eth0', 100, { flags: '0201' })], [route('eth0', 100, { destination: '000200C0', mask: '00FFFFFF' })],
    [route('eth0', 'invalid')], [route('eth0', -1)], [route('eth0', 100, { flags: 'invalid' })]])
    assert.equal(detect(interfaces, routes), '');
  assert.equal(detect(interfaces, [route('eth0', 0, { flags: '0001' })]), '192.0.2.10');
});
