import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { getChartData } from './chart-data.js';
import { simulatedOutlook } from './simulator.js';

function authorized(req, token) {
  if (!token) return true;
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON content type required');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 8192) throw new Error('Request too large');
  }
  return JSON.parse(data);
}
function numberParam(url, key, fallback, max) {
  const n = Number(url.searchParams.get(key) ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`Invalid ${key}`);
  return n;
}

export function createAppServer({ engine, store, chartService, token = '', staticDir = resolve('dist') }) {
  return createServer(async (req, res) => {
    const json = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!token && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host ?? '')) return json(403, { error: 'Unrecognized local host' });
        // Same-origin JSON writes prevent cross-site requests, including on a
        // loopback installation where no bearer token is configured.
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(403, { error: 'Cross-origin request rejected' });
        if (!authorized(req, token)) return json(401, { error: 'Authentication required' });
        if (req.method === 'GET' && url.pathname === '/api/status') return json(200, engine.status());
        if (req.method === 'GET' && url.pathname === '/api/chart') {
          const now = engine.clock();
          const args = { input: engine.config.input, contract: engine.contract(),
            market: store.getState('provider:market'), weather: store.getState('provider:weather'),
            simulated: engine.plant ? simulatedOutlook(now) : null, now,
            startDate: url.searchParams.get('start') ?? undefined,
            endDate: url.searchParams.get('end') ?? undefined,
            left: url.searchParams.get('left') ?? 'power', points: numberParam(url, 'points', 800, 4096) };
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          res.once('close', cancel);
          try {
            const result = chartService ? await chartService.query(args, { signal: cancellation.signal }) : getChartData({ store, ...args });
            if (!res.destroyed) return json(200, result);
          } finally { res.removeListener('close', cancel); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/contract') return json(200, engine.contract());
        if (req.method === 'POST' && ['/api/contract', '/api/settings'].includes(url.pathname)) return json(405, { error: 'Permanent settings and electricity rates are configured in options/config. Restart after editing them.' });
        if (req.method === 'POST' && url.pathname === '/api/temporary') return json(200, engine.setTemporary(await body(req)));
        if (req.method === 'POST' && url.pathname === '/api/test/h66') return json(200, await engine.testH66(await body(req)));
        if (req.method === 'POST' && url.pathname === '/api/heating-test') return json(200, await engine.testHeating(await body(req)));
        if (req.method === 'GET' && url.pathname === '/api/events') return json(200, store.events({ after: numberParam(url, 'after', 0, Number.MAX_SAFE_INTEGER), limit: numberParam(url, 'limit', 100, 500) }));
        if (req.method === 'GET' && url.pathname === '/api/history') {
          const now = engine.clock();
          const from = numberParam(url, 'from', now - 86_400_000, Number.MAX_SAFE_INTEGER);
          const to = numberParam(url, 'to', now, Number.MAX_SAFE_INTEGER);
          if (to < from || to - from > 31 * 86_400_000) throw new Error('History range must be at most 31 days');
          const signal = url.searchParams.get('signal') ?? 'indoor_temperature';
          if (!/^[a-z0-9_]{1,64}$/.test(signal)) throw new Error('Invalid signal');
          return json(200, store.observations({ signal, from, to, limit: numberParam(url, 'limit', 1000, 5000) }));
        }
        if (req.method === 'POST' && url.pathname === '/api/override') return json(200, engine.setOverride((await body(req)).minutes));
        return json(404, { error: 'Unknown endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method not allowed' });
      const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!/^\/[a-zA-Z0-9/_\-.]+$/.test(name) || name.includes('..')) return json(404, { error: 'Not found' });
      const path = resolve(staticDir, `.${name}`);
      if (!path.startsWith(`${resolve(staticDir)}/`)) return json(404, { error: 'Not found' });
      try {
        const data = await readFile(path);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': name.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch {
        json(404, { error: 'UI build not found. Run npm run build.' });
      }
    } catch (error) {
      if (!res.destroyed) json(400, { error: error.message });
    }
  });
}
