import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'vite';
import configuration from '../vite.config.js';
import { readFile } from 'node:fs/promises';

test('A11-H01 development proxy stays on loopback and checks origin before forwarding', async t => {
  const requests = [];
  const backend = httpServer((request,response) => {
    requests.push({ origin: request.headers.origin, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  await new Promise(resolve => backend.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); }));
  assert.equal(configuration.server.host,'127.0.0.1');
  assert.equal(configuration.preview.host,'127.0.0.1');
  const target = `http://127.0.0.1:${backend.address().port}`;
  const server = await createServer({ ...configuration, configFile:false, logLevel:'silent',
    server:{...configuration.server,port:0, proxy:{'/api':{...configuration.server.proxy['/api'],target}}} });
  t.after(() => server.close()); await server.listen();
  assert.equal(server.httpServer.address().address,'127.0.0.1');
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const post = value => fetch(`${origin}/api/status`,{method:'POST',headers:{Origin:value,
    Authorization:'Bearer synthetic-development-token','Content-Type':'application/json'},body:'{}'});
  assert.equal((await post('https://invented-other.invalid')).status,403);
  assert.equal((await post('invalid-origin')).status,403);
  assert.equal(requests.length,0);
  assert.equal((await post(origin)).status,200);
  assert.deepEqual(requests,[{origin:'http://127.0.0.1:1234',authorization:'Bearer synthetic-development-token'}]);
  assert.equal((await fetch(`${origin}/@fs/${new URL('../config.json',import.meta.url).pathname}`)).status,403);
});

test('development commissioning downloads require the API and cannot bypass access through public files', async t => {
  const resources = new Map(await Promise.all([
    ['/api/downloads/floor-preheat-guide', '../docs/floor-preheat.md'],
  ].map(async ([path, relative]) => [path, await readFile(new URL(relative, import.meta.url), 'utf8')])));
  const requests = [];
  const backend = httpServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (!request.headers.authorization) { response.writeHead(401); response.end('Authentication required'); return; }
    if (request.headers.authorization !== 'Bearer synthetic-development-admin-token') {
      response.writeHead(403); response.end('Admin access required'); return;
    }
    if (!resources.has(request.url)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(resources.get(request.url));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); }));
  const target = `http://127.0.0.1:${backend.address().port}`;
  const server = await createServer({ ...configuration, configFile: false, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { ...configuration.server, port: 0,
      proxy: { '/api': { ...configuration.server.proxy['/api'], target } } } });
  t.after(() => server.close()); await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const relative of ['../docs/floor-preheat.md', '../scripts/check-secrets.js']) {
    for (const suffix of ['', '?url', '?raw']) {
      assert.equal((await fetch(`${origin}/@fs${new URL(relative, import.meta.url).pathname}${suffix}`)).status, 403,
        'Device downloads cannot escape API authorization through Vite file serving');
    }
  }
  assert.equal(requests.length, 0, 'Blocked public file requests never reach the backend');
  for (const [path, body] of resources) {
    assert.equal((await fetch(`${origin}${path}`)).status, 401);
    assert.equal((await fetch(`${origin}${path}`, { headers: { Authorization: 'Bearer synthetic-development-family-token' } })).status, 403);
    const download = await fetch(`${origin}${path}`, { headers: { Authorization: 'Bearer synthetic-development-admin-token' } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), body, 'The proxy must preserve API download bytes without Vite transforms');
    assert.deepEqual(requests.slice(-3), [undefined, 'Bearer synthetic-development-family-token', 'Bearer synthetic-development-admin-token']
      .map(authorization => ({ path, authorization })));
  }
});
