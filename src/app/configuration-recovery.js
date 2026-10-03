import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configurationValidationMessage } from './configuration-preview.js';
import { recoveryPage } from './configuration-recovery-page.js';

const matches = (left, right) => typeof left === 'string' && typeof right === 'string'
  && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const ingressProxy = address => ['172.30.32.2', '::ffff:172.30.32.2'].includes(address);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const describeError = (error, information) => {
  const labels = { defaults: 'Bundled defaults', 'private-file': 'Configuration file',
    'import-file': 'Uploaded secrets.json', 'home-assistant-options': 'Saved Home Assistant settings' };
  const label = Object.hasOwn(labels, error?.configurationSource ?? '') ? labels[error.configurationSource] : null;
  const receiptLocation = error?.configurationSource === 'import-receipt' && information.receiptPath
    ? ` Recovery record: ${information.receiptPath}` : '';
  return `${label ? `${label}: ` : ''}${configurationValidationMessage(error)}${receiptLocation}`;
};

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('JSON content type required.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw fail('Request too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail('A JSON object is required.'); }
}

/** Serve configuration only. This module never opens a store or starts a runtime. */
export async function startConfigurationRecovery({ source, error, env = process.env,
  clock = Date.now, installSignalHandlers = true, log = value => console.log(JSON.stringify(value)) }) {
  const addon = env.STMQ_ADDON === '1';
  const information = await source.recoveryInfo();
  const environment = addon ? 'home-assistant' : 'linux';
  // A malformed configuration cannot select a network listener or grant access.
  const proposedPort = Number(env.STMQ_PORT ?? 1234);
  const port = addon ? information.ingressPort
    : Number.isInteger(proposedPort) && proposedPort >= 0 && proposedPort <= 65535 ? proposedPort : 1234;
  if (addon && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error('Configuration recovery needs an assigned Home Assistant ingress port. Check Supervisor and restart the app.');
  const host = addon ? '0.0.0.0' : '127.0.0.1';
  const csrf = randomBytes(32).toString('hex'), accessKey = addon ? null : randomBytes(32).toString('hex');
  let keyDirectory, keyPath, busy = false, closed = false, review = null;
  let problem = describeError(error, information), receipt = null;
  if (!addon) {
    // systemd's PrivateTmp hides /tmp from the host. Prefer the explicitly
    // configured service data directory so its owner can retrieve the key.
    if (env.STMQ_DATA_DIR) {
      try {
        const directory = resolve(env.STMQ_DATA_DIR);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        keyDirectory = mkdtempSync(join(directory, 'configuration-recovery-'));
      } catch { /* A broken storage path must not prevent local recovery. */ }
    }
    keyDirectory ??= mkdtempSync(join(tmpdir(), 'stmq-recovery-'));
    chmodSync(keyDirectory, 0o700);
    keyPath = join(keyDirectory, 'access-key');
    writeFileSync(keyPath, `${accessKey}\n`, { mode: 0o600, flag: 'wx' });
  }
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`);
    try {
      if (closed) return json(503, { error: 'Configuration recovery is stopping.' });
      if (addon && !ingressProxy(req.socket.remoteAddress)) return json(403, { error: 'Ingress proxy required.' });
      const hostHeader = addon ? req.headers['x-forwarded-host'] ?? req.headers.host : req.headers.host;
      if (typeof hostHeader !== 'string' || !hostHeader || /[\s,/@\\]/.test(hostHeader))
        return json(403, { error: 'Unrecognized request host.' });
      let hostValid = false;
      try { hostValid = new URL(`http://${hostHeader}`).host === hostHeader.toLowerCase(); } catch { /* Invalid host. */ }
      if (!hostValid || !addon && !/^(localhost|127\.0\.0\.1)(?::\d+)?$/.test(hostHeader))
        return json(403, { error: 'Unrecognized request host.' });
      if (req.headers.origin) {
        let sameOrigin = false;
        try { sameOrigin = new URL(req.headers.origin).host === hostHeader.toLowerCase(); } catch { /* Invalid origin. */ }
        if (!sameOrigin) return json(403, { error: 'Cross-origin request rejected.' });
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(recoveryPage({ csrfToken: csrf, environment, nonce }));
      }
      if (!url.pathname.startsWith('/api/recovery')) return json(404, { error: 'Only configuration recovery is available.' });
      if (!addon && !matches(req.headers.authorization, `Bearer ${accessKey}`))
        return json(401, { error: 'Enter the recovery access key from the private file shown in the service log.' });
      if (req.method === 'GET' && url.pathname === '/api/recovery')
        return json(200, { environment, error: problem, privatePath: information.privatePath,
          importPath: information.importPath, externalImportPath: information.externalImportPath,
          receipt, controlAvailable: false });
      if (req.method !== 'POST' || !['/api/recovery/preview', '/api/recovery/apply'].includes(url.pathname))
        return json(404, { error: 'Only configuration recovery is available.' });
      if (!matches(req.headers['x-recovery-csrf'], csrf)) return json(403, { error: 'Reload the recovery page before continuing.' });
      const body = await readBody(req);
      if (closed) return json(503, { error: 'Configuration recovery is stopping.' });
      if (busy) return json(409, { error: 'Configuration is being checked or saved. Wait for it to finish.' });
      busy = true;
      try {
        if (url.pathname.endsWith('/preview')) {
          review = null;
          if (Object.keys(body).some(key => key !== 'replacement') || typeof body.replacement !== 'boolean')
            throw fail('Choose whether to merge or replace the saved settings.');
          if (body.replacement && !addon) throw fail('On Linux, edit the configuration file directly.');
          const transaction = await source.prepare({ replacement: body.replacement });
          review = { id: randomUUID(), fingerprint: transaction.reviewFingerprint,
            replacement: body.replacement, expires: clock() + 300_000 };
          return json(200, { reviewId: review.id, replacement: review.replacement,
            changes: transaction.recoveryChanges ?? [], valid: true, canApply: true });
        }
        if (Object.keys(body).some(key => key !== 'reviewId') || typeof body.reviewId !== 'string')
          throw fail('Review the configuration before saving.');
        const accepted = review;
        review = null;
        if (!accepted || accepted.id !== body.reviewId || accepted.expires <= clock())
          throw fail('Configuration review expired. Check and review the configuration again.', 409);
        const transaction = await source.prepare({ replacement: accepted.replacement });
        if (!transaction.reviewFingerprint || transaction.reviewFingerprint !== accepted.fingerprint)
          throw fail('Configuration changed after review. Check and review it again.', 409);
        if (closed) throw fail('Configuration recovery is stopping.', 503);
        await transaction.persist();
        // Normal startup owns completion and import cleanup after runtime success.
        // No restart or equipment connection is triggered by an HTTP request.
        problem = '';
        receipt = { at: clock(), saved: addon,
          message: addon ? 'Configuration saved. Restart this app from Home Assistant to start normal operation.'
            : 'Configuration is valid. Restart the application or its Linux service to start normal operation.',
          backupPath: transaction.backupPath ?? null };
        return json(200, receipt);
      } finally { busy = false; }
    } catch (failure) {
      problem = describeError(failure, information);
      receipt = null;
      json(failure.statusCode ?? 400, { error: problem });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const signals = new Map();
  let closing;
  function close() {
    if (closing) return closing;
    closed = true;
    review = null;
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
    closing = new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }).finally(() => { if (keyDirectory) rmSync(keyDirectory, { recursive: true, force: true }); });
    return closing;
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
    if (installSignalHandlers) for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { void close(); };
      signals.set(signal, handler);
      process.once(signal, handler);
    }
    log({ event: 'configuration-recovery', environment, address: server.address(),
      ...(keyPath ? { accessKeyFile: keyPath } : {}), controlAvailable: false });
  } catch (failure) { await close(); throw failure; }
  return { recovery: true, server, close, keyPath };
}
