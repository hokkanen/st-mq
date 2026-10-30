#!/usr/bin/env node
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import mqtt from 'mqtt';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const privateJson = path => {
  const actual = realpathSync(path), inside = relative(root, actual);
  const outside = inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  if (!outside || statSync(actual).mode & 0o077 || statSync(dirname(actual)).mode & 0o077)
    throw Error('Private input must be outside the checkout');
  return JSON.parse(readFileSync(actual, 'utf8'));
};

let client;
let stage = 'private configuration';
const bounded = promise => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Broker response timed out')), 7000);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
try {
  if (!process.argv[2] || process.argv.slice(3).some(x => x !== '--restricted')) throw Error('Invalid arguments');
  const c = privateJson(process.argv[2]), login = privateJson(c.login_file), url = new URL(c.address);
  if (url.protocol !== 'mqtts:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw Error('A plain TLS MQTT origin is required');
  if (!/^[a-f0-9]{32}$/.test(c.uuid) || typeof login.username !== 'string' || typeof login.password !== 'string')
    throw Error('Invalid native login');
  const fingerprint = new X509Certificate(readFileSync(c.server_certificate)).fingerprint256;
  stage = 'TLS authentication';
  client = mqtt.connect(url.href, { username: login.username, password: login.password,
    ca: readFileSync(c.ca_certificate ?? c.server_certificate), reconnectPeriod: 0, connectTimeout: 5000,
    clean: true, resubscribe: false, queueQoSZero: false,
    checkServerIdentity: (_host, certificate) => new X509Certificate(certificate.raw).fingerprint256 === fingerprint
      ? undefined : Error('Server certificate pin differs') });
  client.on('error', () => {});
  await bounded(new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); }));
  stage = 'native subscription';
  const granted = await bounded(client.subscribeAsync(`/appliance/${c.uuid}/subscribe`, { qos: 1 }));
  if (granted[0]?.qos === 128) throw Error('Native subscription denied');
  let denied = false;
  stage = 'topic restriction';
  try { denied = (await bounded(client.subscribeAsync('stmq/qualification/unrelated', { qos: 1 })))[0]?.qos === 128; }
  catch (error) {
    const reason = error.packet?.cmd === 'suback' ? error.packet.granted?.[0] : error.code;
    if (reason === 128 || reason === 135) denied = true; else throw error;
  }
  if (process.argv.includes('--restricted') && !denied) throw Error('Unrelated topic was allowed');
  console.log(JSON.stringify({ authenticated: true, certificatePinned: true,
    nativeSubscription: true, unrelatedSubscriptionDenied: denied }));
} catch {
  console.error(`Broker verification failed at ${stage}. No device command was sent.`);
  process.exitCode = 1;
} finally {
  if (client) await client.endAsync(true);
}
