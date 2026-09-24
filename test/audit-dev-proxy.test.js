import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'vite';
import configuration from '../vite.config.js';

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
