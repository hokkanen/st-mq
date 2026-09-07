import { readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHttp, ProviderError } from '../../src/acquisition/http.js';

export const LIVE_SERVICES = Object.freeze([
  'entsoe', 'elering', 'fmi-forecast', 'fmi-observation',
  'openweather-forecast', 'openweather-current', 'smartthings', 'easee',
]);
export const SERVICE_HOSTS = Object.freeze({
  entsoe: 'web-api.tp.entsoe.eu', elering: 'dashboard.elering.ee',
  'fmi-forecast': 'opendata.fmi.fi', 'fmi-observation': 'opendata.fmi.fi',
  'openweather-forecast': 'api.openweathermap.org', 'openweather-current': 'api.openweathermap.org',
  smartthings: 'api.smartthings.com', easee: 'api.easee.com',
});
const HOSTS = new Set(Object.values(SERVICE_HOSTS));
const LIMITS = Object.freeze({ entsoe: 1, elering: 1, fmi: 2, 'owm-forecast': 1,
  'owm-current': 1, smartthings: 3, 'easee-read': 4, 'easee-refresh': 1, 'easee-login': 1 });
const HALF_HOUR = 30 * 60_000;

export function livePaths(env = process.env, cwd = process.cwd()) {
  const addon = env.STMQ_ADDON === '1';
  const dataDirectory = resolve(cwd, env.STMQ_DATA_DIR ?? (addon ? '/data/st-mq' : 'var'));
  return {
    configPath: resolve(cwd, env.STMQ_CONFIG ?? (addon ? '/data/options.json' : 'data/options.json')),
    directory: resolve(cwd, env.STMQ_LIVE_DATA_DIR ?? join(dataDirectory, 'live-test')),
  };
}

export function selectedServices(value = '') {
  const selected = value ? value.split(',').map(item => item.trim()) : [...LIVE_SERVICES];
  if (!selected.length || selected.some(item => !LIVE_SERVICES.includes(item)) || new Set(selected).size !== selected.length) {
    throw new Error('Select unique live services from the documented service list');
  }
  return selected;
}

export function readLiveState(directory) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { attemptedAt: {}, blockedUntil: {} }; throw new Error('Live-test cooldown state cannot be read'); }
  const state = { attemptedAt: {}, blockedUntil: {} };
  for (const key of LIVE_SERVICES) if (Number.isSafeInteger(raw?.attemptedAt?.[key])) state.attemptedAt[key] = raw.attemptedAt[key];
  for (const key of HOSTS) if (Number.isSafeInteger(raw?.blockedUntil?.[key])) state.blockedUntil[key] = raw.blockedUntil[key];
  return state;
}

export function writeLiveState(directory, state) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'state.json'), temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, path); chmodSync(path, 0o600);
  } catch { throw new Error('Live-test cooldown state cannot be saved'); }
}

export function liveCooldowns(state, selected, now = Date.now()) {
  return selected.flatMap(service => {
    const retryAt = Math.max((state.attemptedAt[service] ?? 0) + 60_000, state.blockedUntil[SERVICE_HOSTS[service]] ?? 0);
    return retryAt > now ? [{ service, seconds: Math.ceil((retryAt - now) / 1000) }] : [];
  });
}

function classify(urlInput, options) {
  let url;
  try { url = new URL(urlInput); } catch { throw new ProviderError('live-request-not-allowed'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new ProviderError('live-request-not-allowed');
  const method = options?.method ?? 'GET';
  if (url.hostname === 'api.easee.com' && method === 'POST') {
    if (url.pathname === '/api/accounts/refresh_token') return { host: url.hostname, kind: 'easee-refresh' };
    if (url.pathname === '/api/accounts/login') return { host: url.hostname, kind: 'easee-login' };
  }
  if (method !== 'GET') throw new ProviderError('live-device-writes-not-allowed');
  const routes = [
    ['web-api.tp.entsoe.eu', /^\/api\/?$/, 'entsoe'],
    ['dashboard.elering.ee', /^\/api\/nps\/price\/?$/, 'elering'],
    ['opendata.fmi.fi', /^\/wfs\/?$/, 'fmi'],
    ['api.openweathermap.org', /^\/data\/2\.5\/forecast$/, 'owm-forecast'],
    ['api.openweathermap.org', /^\/data\/2\.5\/weather$/, 'owm-current'],
    ['api.smartthings.com', /^\/v1\/devices\/[^/]+\/status$/, 'smartthings'],
    ['api.easee.com', /^\/state\/[^/]+\/observations$/, 'easee-read'],
  ];
  const route = routes.find(([host, path]) => host === url.hostname && path.test(url.pathname));
  if (!route) throw new ProviderError('live-request-not-allowed');
  return { host: url.hostname, kind: route[2] };
}

/** An extra live-test boundary: serial transport, a finite request budget and no
 * repeated calls to a provider that denied access or rate-limited this run. */
export function createLiveHttp({ fetchImpl = globalThis.fetch, now = () => Date.now(),
  state = { attemptedAt: {}, blockedUntil: {} }, saveState = () => {}, timeoutMs = 12_000 } = {}) {
  const http = createHttp({ fetchImpl, timeoutMs, maxBytes: 4 * 1024 * 1024 });
  const counts = {}, failures = {};
  let queue = Promise.resolve(), total = 0;
  let closed = false, easeeAuthenticationFailed = false;
  async function bounded(kind, url, options) {
    const route = classify(url, options);
    if (closed) throw new ProviderError('provider-client-closed');
    if ((state.blockedUntil[route.host] ?? 0) > now()) throw new ProviderError('live-provider-cooldown');
    if (route.host === 'api.easee.com' && easeeAuthenticationFailed) throw new ProviderError('live-authentication-stopped');
    if (total >= 20 || (counts[route.kind] ?? 0) >= LIMITS[route.kind]) throw new ProviderError('live-request-budget-exhausted');
    counts[route.kind] = (counts[route.kind] ?? 0) + 1; total++;
    try { return await http[kind](url, options); }
    catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : null;
      const code = typeof error?.code === 'string' && /^[a-z-]{1,60}$/.test(error.code) ? error.code : 'provider-request-failed';
      failures[route.host] = status ? `HTTP ${status}` : code;
      const terminalAuth = [401, 403].includes(status) &&
        (route.host !== 'api.easee.com' || route.kind === 'easee-login' ||
          (route.kind === 'easee-read' && (status === 403 || counts['easee-refresh'] || counts['easee-login'])));
      if (terminalAuth || status === 429) {
        const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? Math.min(24 * 3_600_000, Math.max(0, error.retryAfterMs)) : 0;
        state.blockedUntil[route.host] = now() + Math.max(HALF_HOUR, retryAfterMs);
        if (route.host === 'api.easee.com') easeeAuthenticationFailed = true;
        saveState(state);
      }
      throw error;
    }
  }
  function enqueue(kind, url, options = {}) {
    const operation = queue.then(() => bounded(kind, url, options));
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    text: (url, options) => enqueue('text', url, options),
    json: (url, options) => enqueue('json', url, options),
    summary: () => ({ requests: total, counts: { ...counts }, failures: { ...failures } }),
    close() { closed = true; http.close(); },
  };
}
