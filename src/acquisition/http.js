const ALLOWED_HOSTS = new Set(['api.smartthings.com', 'api.easee.com', 'web-api.tp.entsoe.eu',
  'dashboard.elering.ee', 'api.openweathermap.org', 'opendata.fmi.fi']);

export class ProviderError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'ProviderError'; this.code = code; this.status = status;
  }
}

/** Finite requests with sanitized errors: URLs, authorization and response bodies
 * are deliberately excluded because providers sometimes echo credentials. */
export function createHttp({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxBytes = 2 * 1024 * 1024 } = {}) {
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
    if (method !== 'GET' && !(method === 'POST' && authentication)) throw new ProviderError('device-writes-not-allowed');
    if (closed) throw new ProviderError('provider-client-closed');
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let reader, response;
    try {
      response = await fetchImpl(url.href, { ...options, method, redirect: 'error', signal });
      if (!response.ok) throw new ProviderError('provider-http-error', response.status);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderError('provider-response-too-large');
      if (!response.body) throw new ProviderError('empty-provider-response');
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
      throw new ProviderError(signal.aborted ? 'provider-request-aborted' : 'provider-network-error');
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
