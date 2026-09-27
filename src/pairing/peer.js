import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { pairError } from './state.js';

const MAX_BODY = 2 * 1024 * 1024;
const WINDOW = 120000;
const ROUTE = '/v2/pair';
const CONTEXT = 'st-mq-pair-v2:POST:/v2/pair';

function keyFor(token) {
  if (typeof token !== 'string' || token.length < 32) throw pairError('pair_token_invalid');
  return createHash('sha256').update('st-mq paired transport\0').update(token).digest();
}

export function sealEnvelope(value, key, context = CONTEXT) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 2, nonce: nonce.toString('base64'),
    data: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
}

export function openEnvelope(raw, key, context = CONTEXT) {
  try {
    const value = JSON.parse(raw);
    if (value.version !== 2 || ![value.nonce, value.data, value.tag].every(part => typeof part === 'string')) throw Error();
    const nonce = Buffer.from(value.nonce, 'base64'), tag = Buffer.from(value.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw Error();
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw pairError('peer_authentication_failed'); }
}

async function readBounded(stream) {
  const chunks = [];
  let length = 0;
  for await (const part of stream) {
    const chunk = Buffer.from(part);
    length += chunk.length;
    if (length > MAX_BODY) throw pairError('peer_message_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const PUBLIC_ERRORS = new Set(['peer_unavailable', 'peer_authentication_failed', 'peer_message_too_large',
  'peer_protocol_failed', 'peer_replay', 'peer_busy', 'not_master', 'protected_history', 'invalid_claim',
  'invalid_action', 'snapshot_unavailable', 'snapshot_failed', 'verification_failed', 'integrity_failed',
  'lineage_mismatch', 'authority_changed', 'recovery_required', 'invalid_transition', 'transfer_incomplete',
  'invalid_pair_state', 'confirmation_required', 'invalid_request_id', 'recovery_unavailable', 'snapshot_expired',
  'vip_failed', 'vip_helper_unavailable', 'vip_helper_permission', 'vip_policy_invalid', 'vip_policy_mismatch',
  'vip_interface_missing', 'vip_command_failed', 'vip_announce_failed', 'vip_release_failed',
  'mqtt_local_required', 'mqtt_resolution_failed', 'runtime_failed', 'ocpp_handover_not_ready', 'stopped', 'timed_out']);
export function publicPairError(error) { return PUBLIC_ERRORS.has(error?.code) ? error.code : 'peer_protocol_failed'; }

/** The LAN transport never sends the pairing secret or household data in plaintext. */
export class PairPeer {
  constructor({ token, pairId, peerUrl, listenHost = '0.0.0.0', port = 8091, timeoutMs = 10000,
    clock = Date.now, fetchImpl = fetch, handler }) {
    this.key = keyFor(token);
    this.pairId = pairId;
    this.peerUrl = peerUrl;
    this.listenHost = listenHost;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.fetchImpl = fetchImpl;
    this.handler = handler;
    this.nonces = new Map();
    this.closed = false;
    this.abort = new AbortController();
    this.activeRequests = 0;
    this.inflight = new Set();
    this.lastNonceSweep = 0;
  }

  async start() {
    this.server = createServer((req, res) => {
      if (this.activeRequests >= 8) { req.resume(); res.writeHead(503); res.end(); return; }
      this.activeRequests++;
      const task = this.serve(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }).finally(() => { this.activeRequests--; this.inflight.delete(task); });
      this.inflight.add(task);
    });
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    this.server.maxHeadersCount = 32;
    this.server.maxConnections = 16;
    this.server.maxRequestsPerSocket = 1000;
    await new Promise((accept, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.listenHost, () => { this.server.off('error', reject); accept(); });
    });
    this.server.on('error', () => {});
    return this.server.address();
  }

  async serve(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (this.closed || req.method !== 'POST' || req.url !== ROUTE) { res.writeHead(404); res.end(); return; }
    let request;
    try {
      if (Number(req.headers['content-length']) > MAX_BODY) throw pairError('peer_message_too_large');
      request = openEnvelope(await readBounded(req), this.key);
      if (request.pairId !== this.pairId || typeof request.id !== 'string' || request.id.length > 80 ||
          typeof request.operation !== 'string' || !Number.isSafeInteger(request.at) ||
          Math.abs(this.clock() - request.at) > WINDOW) throw pairError('peer_authentication_failed');
      const now = this.clock();
      if (now - this.lastNonceSweep >= 1000 || now < this.lastNonceSweep) {
        for (const [id, expires] of this.nonces) if (expires <= now) this.nonces.delete(id);
        this.lastNonceSweep = now;
      }
      // Bound memory without throttling a large LAN catchup after a few thousand
      // chunks. Cleanup runs once per second rather than scanning per chunk.
      if (this.nonces.has(request.id) || this.nonces.size >= 65536) throw pairError('peer_replay');
      this.nonces.set(request.id, now + WINDOW * 2);
    } catch { res.writeHead(401); res.end(); return; }
    let reply;
    try { reply = { ok: true, value: await this.handler(request.operation, request.body ?? {}) }; }
    catch (error) { reply = { ok: false, error: publicPairError(error) }; }
    if (res.destroyed) return;
    const body = sealEnvelope({ id: request.id, pairId: this.pairId, ...reply }, this.key, `${CONTEXT}:response:${request.id}`);
    if (Buffer.byteLength(body) > MAX_BODY) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async request(operation, body = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) throw pairError('stopped');
    const id = randomUUID();
    const request = sealEnvelope({ id, pairId: this.pairId, at: this.clock(), operation, body }, this.key);
    if (Buffer.byteLength(request) > MAX_BODY) throw pairError('peer_message_too_large');
    const signals = [this.abort.signal, AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    try {
      const url = new URL(ROUTE, this.peerUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw pairError('peer_protocol_failed');
      const response = await this.fetchImpl(url, { method: 'POST', body: request,
        headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.any(signals) });
      if (!response.ok) throw pairError(response.status === 401 ? 'peer_authentication_failed' : 'peer_unavailable');
      const result = openEnvelope(await readBounded(response.body), this.key, `${CONTEXT}:response:${id}`);
      if (result.id !== id || result.pairId !== this.pairId) throw pairError('peer_authentication_failed');
      if (!result.ok) throw pairError(PUBLIC_ERRORS.has(result.error) ? result.error : 'peer_protocol_failed');
      return result.value;
    } catch (error) { throw pairError(PUBLIC_ERRORS.has(error?.code) ? error.code : 'peer_unavailable'); }
  }

  async close() {
    this.closed = true;
    this.abort.abort(pairError('stopped'));
    if (this.server?.listening) {
      const done = new Promise(resolve => this.server.close(resolve));
      this.server.closeAllConnections();
      await done;
    }
    await Promise.allSettled([...this.inflight]);
  }
}
