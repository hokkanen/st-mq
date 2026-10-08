const ALLOWED_HOSTS = new Set(['api.easee.com', 'web-api.tp.entsoe.eu',
  'dashboard.elering.ee', 'api.open-meteo.com', 'opendata.fmi.fi', 'api.energypriceforecast.eu']);
const FAILURE_CODES = new Set(['provider-request-timeout', 'provider-request-aborted',
  'provider-network-error', 'invalid-provider-json', 'invalid-provider-observations',
  'provider-response-too-large', 'empty-provider-response']);

/** Retain only known diagnostics, never provider messages, URLs or bodies. */
export function providerFailureCode(error) {
  return Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? `HTTP-${error.status}` : FAILURE_CODES.has(error?.code) ? error.code : 'provider-request-failed';
}

export class ProviderError extends Error {
  constructor(code, status = null, retryAfterMs = null) {
    super(code);
    this.name = 'ProviderError'; this.code = code; this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryDelay(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : null;
  const delay = seconds === null ? Date.parse(value) - Date.now() : seconds * 1000;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(24 * 3600_000, Math.max(1000, delay)) : null;
}

/** Finite requests with sanitized errors: URLs, authorization and response bodies
 * are deliberately excluded because providers sometimes echo credentials. */
export function createHttp({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxBytes = 2 * 1024 * 1024,
  allowChargerScheduling = false, allowChargerTakeover = false, allowOcppSetup = false, canControl = () => true } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid provider timeout');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Invalid provider response limit');
  const pending = new Set();
  let closed = false;
  async function text(urlInput, options = {}) {
    let url;
    try { url = new URL(urlInput); } catch { throw new ProviderError('invalid-provider-url'); }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new ProviderError('provider-origin-not-allowed');
    const method = options.method ?? 'GET';
    const authentication = url.hostname === 'api.easee.com' && ['/api/accounts/login', '/api/accounts/refresh_token'].includes(url.pathname);
    let scheduling = false;
    if (allowChargerScheduling === true && method === 'POST' && url.hostname === 'api.easee.com' && !url.search && !url.hash) {
      if (/^\/api\/chargers\/[^/]+\/schedules\/(?:delayed|daily|weekly)\/disable$/.test(url.pathname))
        scheduling = options.body === undefined;
      else if (/^\/api\/chargers\/[^/]+\/schedules\/delayed$/.test(url.pathname)) {
        let body;
        try { body = typeof options.body === 'string' && options.body.length <= 512 ? JSON.parse(options.body) : null; } catch { body = null; }
        scheduling = body !== null && typeof body === 'object' && !Array.isArray(body)
          && Object.keys(body).sort().join(',') === 'enabled,maximumAmps,startTime,timezone'
          && body.enabled === true && Number.isInteger(body.maximumAmps) && body.maximumAmps >= 6 && body.maximumAmps <= 80
          && typeof body.timezone === 'string' && body.timezone.length > 0 && body.timezone.length <= 100
          && typeof body.startTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(body.startTime);
      }
    }
    let takeover = false;
    if (allowChargerTakeover === true && method === 'POST' && url.hostname === 'api.easee.com' && !url.search && !url.hash) {
      if (/^\/api\/chargers\/[^/]+\/commands\/resume_charging$/.test(url.pathname))
        takeover = options.body === undefined;
      else if (/^\/api\/chargers\/[^/]+\/settings$/.test(url.pathname)) {
        let body;
        try { body = typeof options.body === 'string' && options.body.length <= 128 ? JSON.parse(options.body) : null; } catch { body = null; }
        takeover = body !== null && typeof body === 'object' && !Array.isArray(body)
          && Object.keys(body).join(',') === 'enabled' && body.enabled === true;
      }
    }
    let ocppSetup = false;
    if (allowOcppSetup === true && method === 'POST' && url.hostname === 'api.easee.com' && !url.search && !url.hash) {
      let body;
      try { body = typeof options.body === 'string' && options.body.length <= 20000 ? JSON.parse(options.body) : null; } catch { body = null; }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        if (/^\/local-ocpp\/v1\/connections\/chargers\/[^/]+$/.test(url.pathname))
          ocppSetup = Object.keys(body).join(',') === 'version' && typeof body.version === 'string'
            && body.version.length > 0 && body.version.length <= 200 && !/[\u0000-\u001f]/.test(body.version);
        else if (/^\/local-ocpp\/v1\/connection-details\/[^/]+$/.test(url.pathname)) {
          const args = body.websocketConnectionArgs;
          let endpoint; try { endpoint = new URL(args?.url); } catch {}
          ocppSetup = Object.keys(body).sort().join(',') === 'basicAuthPassword,chargePointId,connectivityMode,websocketConnectionArgs'
            && ['DualProtocol', 'OcppOff'].includes(body.connectivityMode) && typeof body.chargePointId === 'string'
            && body.chargePointId.length > 0 && body.chargePointId.length <= 128 && !/[/:\s]/.test(body.chargePointId)
            && typeof body.basicAuthPassword === 'string' && body.basicAuthPassword.length >= 16 && body.basicAuthPassword.length <= 20
            && args && typeof args === 'object' && !Array.isArray(args)
            && Object.keys(args).sort().join(',') === 'caCertificate,caCertificateDomain,url'
            && typeof args.url === 'string' && args.url.length <= 2048 && ['ws:', 'wss:'].includes(endpoint?.protocol)
            && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname.endsWith('/ocpp')
            && ['caCertificate', 'caCertificateDomain'].every(key => args[key] === null || typeof args[key] === 'string')
            && (endpoint.protocol === 'ws:' ? args.caCertificate === null && args.caCertificateDomain === null
              : typeof args.caCertificate === 'string' && args.caCertificate.includes('-----BEGIN CERTIFICATE-----')
                && args.caCertificateDomain === endpoint.hostname);
        }
      }
    }
    if (method !== 'GET' && !(method === 'POST' && (authentication || scheduling || takeover || ocppSetup))) throw new ProviderError('device-writes-not-allowed');
    if (closed) throw new ProviderError('provider-client-closed');
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let reader, response;
    try {
      if ((scheduling || takeover || ocppSetup) && !canControl()) throw new ProviderError('controller-authority-revoked');
      if (signal.aborted) throw new ProviderError('provider-request-aborted');
      response = await fetchImpl(url.href, { ...options, method, redirect: 'error', signal });
      if (!response.ok) throw new ProviderError('provider-http-error', response.status,
        retryDelay(response.headers.get('retry-after')));
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderError('provider-response-too-large');
      if (!response.body) {
        if (scheduling || takeover || ocppSetup) return '';
        throw new ProviderError('empty-provider-response');
      }
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new ProviderError('provider-response-too-large');
        chunks.push(value);
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(options.signal?.aborted || closed ? 'provider-request-aborted'
        : controller.signal.aborted ? 'provider-request-timeout' : 'provider-network-error');
    } finally {
      clearTimeout(timer); pending.delete(controller);
      if (reader) await reader.cancel().catch(() => {});
      else if (response?.body) await response.body.cancel().catch(() => {});
    }
  }
  return {
    text,
    async json(url, options) {
      const result = await text(url, options);
      try { return JSON.parse(result); } catch { throw new ProviderError('invalid-provider-json'); }
    },
    close() { closed = true; for (const controller of pending) controller.abort(); },
  };
}
