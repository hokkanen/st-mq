import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttp } from '../../src/acquisition/http.js';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { identityConnection, idleIdentityClient } from './identity-mqtt.js';

const phase = process.argv[2];
assert.ok(['headers', 'body', 'partial', 'reload'].includes(phase));
assert.equal(typeof globalThis.gc, 'function');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const arrived = deferred(), bodyReady = deferred();
let requests = 0;
const server = createServer((_request, response) => {
  requests++;
  if (phase !== 'headers') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    if (phase === 'partial') response.write('{"ok":true}');
  }
  arrived.resolve();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const destination = `http://127.0.0.1:${server.address().port}`;
let http, app, directory, release;
try {
  // The approved public origin still passes the real transport boundary. Only
  // its injected fetch implementation routes this fixture to local loopback.
  http = createHttp({ timeoutMs: 2000, fetchImpl: async (_url, options) => {
    const response = await fetch(destination, options);
    bodyReady.resolve();
    return response;
  } });
  if (phase !== 'reload') {
    const external = new AbortController();
    const result = http.json('https://api.energypriceforecast.eu/api/v1/home-assistant/prices', { signal: external.signal });
    const rejected = assert.rejects(result, { code: 'provider-request-aborted' });
    await arrived.promise;
    if (phase !== 'headers') await bodyReady.promise;
    await new Promise(done => setImmediate(done));
    globalThis.gc();
    external.abort(); http.close();
    await rejected;
    assert.equal(requests, 1);
  } else {
    directory = mkdtempSync(join(tmpdir(), 'stmq-http-reload-cancel-'));
    const path = join(directory, 'fixture-options.json');
    writeFileSync(path, JSON.stringify({ controller: { input: 'mqtt' },
      mqtt: { address: 'mqtt://fixture.invalid' }, equipment: { devices: [] } }));
    const config = loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
    const entered = deferred(); release = deferred();
    let ended = 0, publications = 0;
    const connect = (_address, options) => {
      if (identityConnection(options)) return idleIdentityClient();
      const client = new EventEmitter(); client.connected = true;
      client.subscribe = (_topic, _options, done) => done();
      client.publish = (_topic, _payload, _options, done) => { publications++; done(); };
      client.end = (_force, _options, done) => { ended++; done(); };
      return client;
    };
    app = await start({ config, mqttOptions: { connect }, providerOptions: { http },
      readConfig: async () => { entered.resolve(); await release.promise; return config; } });
    await bodyReady.promise;
    await new Promise(done => setImmediate(done));
    globalThis.gc();
    const engine = app.engine;
    const reload = assert.rejects(app.reloadSettings(), /shutting down/);
    await entered.promise;
    const closed = app.close(); release.resolve();
    await Promise.all([closed, reload]);
    assert.equal(app.engine, engine);
    assert.equal(engine.executor.closed, true);
    assert.equal(ended, 1);
    assert.equal(publications, 0);
    assert.ok(requests >= 1);
  }
  console.log(JSON.stringify({ phase, complete: true, requests }));
} finally {
  release?.resolve(); http?.close();
  // Fixture sockets are closed only after all assertions. On a broken baseline
  // the parent kills this bounded synthetic child; closing the source early
  // would hide precisely the cancellation failure under test.
  server.closeAllConnections(); await new Promise(done => server.close(done));
  await app?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
}
