import { X509Certificate, createPrivateKey, createHash } from 'node:crypto';
import { rootCertificates, createServer, connect } from 'node:tls';
import { httpsError } from './storage.js';

export function certificateHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.ts\.net$/.test(value))
    throw httpsError('certificate_hostname_invalid');
  return value;
}

// An isolated local TLS handshake exercises Node's maintained OpenSSL trust
// verifier, including chain, critical extensions, CA constraints and TLS server
// purpose. It never accesses public DNS or requests a certificate. No separate
// executable or verification dependency is needed. Tests may explicitly inject
// fixture roots; production has no configuration/UI trust bypass.
function parseCertificate(certificate, hostname) {
  certificateHostname(hostname);
  if (!certificate || typeof certificate !== 'object' || Array.isArray(certificate) || Object.keys(certificate).some(key => !['cert', 'key'].includes(key)) ||
      typeof certificate.cert !== 'string' || typeof certificate.key !== 'string' || certificate.cert.length > 64 * 1024 || certificate.key.length > 16 * 1024)
    throw httpsError('certificate_size_invalid');
  const blocks = certificate.cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length > 8 || certificate.cert.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw httpsError('certificate_encoding_invalid');
  let leaf, key;
  try { leaf = new X509Certificate(blocks[0]); key = createPrivateKey(certificate.key); }
  catch { throw httpsError('certificate_encoding_invalid'); }
  if (leaf.ca || leaf.checkHost(hostname, { wildcards: false, partialWildcards: false, multiLabelWildcards: false, subject: 'never' }) !== hostname)
    throw httpsError('certificate_hostname_mismatch');
  const notBefore = Date.parse(leaf.validFrom); const expiresAt = Date.parse(leaf.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || expiresAt <= notBefore) throw httpsError('certificate_encoding_invalid');
  if (leaf.keyUsage && !leaf.keyUsage.includes('1.3.6.1.5.5.7.3.1')) throw httpsError('certificate_server_usage_invalid');
  if (!leaf.checkPrivateKey(key)) throw httpsError('certificate_key_mismatch');
  return { leaf, metadata: { hostname, notBefore, expiresAt, fingerprint: createHash('sha256').update(leaf.raw).digest('hex'),
    renewalWindowMs: Math.min((expiresAt - notBefore) / 3, 30 * 24 * 60 * 60 * 1000) } };
}

export function inspectCertificate(certificate, hostname) { return parseCertificate(certificate, hostname).metadata; }

export async function validateCertificate(certificate, hostname, { now = Date.now(), trustedRoots = rootCertificates } = {}) {
  const { leaf, metadata } = parseCertificate(certificate, hostname);
  if (metadata.notBefore > now || metadata.expiresAt <= now) throw httpsError('certificate_not_current');
  const sockets = new Set();
  let server;
  try {
    server = createServer({ cert: certificate.cert, key: certificate.key, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    await new Promise((ready, reject) => { server.once('error', () => reject(httpsError('certificate_local_check_unavailable'))); server.listen(0, '127.0.0.1', ready); });
    await new Promise((ready, reject) => {
      // A new connection with no session explicitly checks the current complete
      // chain; a resumed TLS session cannot hide an incomplete intermediate.
      const socket = connect({ host: '127.0.0.1', port: server.address().port, servername: hostname, cert: undefined,
        rejectUnauthorized: true, ca: trustedRoots, minVersion: 'TLSv1.2' });
      const timer = setTimeout(() => { socket.destroy(); reject(httpsError('certificate_trust_check_timeout')); }, 5000);
      socket.once('error', () => { clearTimeout(timer); reject(httpsError('certificate_chain_untrusted')); });
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        const presented = socket.getPeerCertificate();
        const matches = socket.authorized && presented.raw && leaf.raw.equals(presented.raw);
        socket.destroy(); matches ? ready() : reject(httpsError('certificate_chain_untrusted'));
      });
    });
  } catch (error) { throw error?.code?.startsWith('certificate_') ? error : httpsError('certificate_encoding_invalid'); }
  finally { for (const socket of sockets) socket.destroy(); if (server?.listening) await new Promise(resolveClose => server.close(resolveClose)); }
  return metadata;
}

export function renewalMinimumValidity(metadata) {
  if (!metadata) return '1h';
  const lifetime = metadata.expiresAt - metadata.notBefore;
  const window = Math.min(lifetime / 3, 30 * 86400000);
  // Request more than the renewal threshold while staying below the actual
  // issued lifetime. Asking for exactly W can simply return the cached cert.
  return `${Math.max(1, Math.floor(Math.min(window + Math.max(3600000, window / 10), lifetime * 0.8) / 1000))}s`;
}
