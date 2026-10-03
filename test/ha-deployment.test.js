import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { connectHA, runTerminal, shellQuote } from '../scripts/lib/ha-deploy-transport.js';
import { validateConnection, selectApp, validateDeploymentState } from '../scripts/deploy-ha.js';

async function fixture(t, onSocket, handler) {
  const server = createServer(handler ?? ((_req, res) => { res.writeHead(404); res.end(); }));
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', onSocket);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('deployment connection rejects unknown fields, embedded credentials and unsafe slugs', () => {
  const valid = { url: 'http://home-assistant.invalid:8123', token_path: '/private/token' };
  assert.equal(validateConnection(valid).url, valid.url);
  for (const patch of [{ token: 'synthetic-unknown' }, { url: 'http://user:pw@home-assistant.invalid' }, { url: 'file:///tmp/file' }, { url: 'http://home-assistant.invalid/redirect' }, { token_path: './token' }, { app_slug: 'app; false' }]) {
    assert.throws(() => validateConnection({ ...valid, ...patch }));
  }
});

test('deployment refuses ambiguous or missing apps and accepts explicit selection', () => {
  const apps = [{ slug: 'one_st-mq' }, { slug: 'two_st-mq' }];
  assert.throws(() => selectApp(apps, undefined, 'app'), /exactly one/);
  assert.throws(() => selectApp(apps, 'missing', 'app'), /exactly one/);
  assert.equal(selectApp(apps, 'two_st-mq', 'app').slug, 'two_st-mq');
});

test('shell quoting preserves substitution syntax and apostrophes literally', () => {
  const value = "it's $(printf unsafe) `printf unsafe`\nnext";
  const output = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(output, value);
});

test('HA authenticates and correlates responses arriving out of order', async t => {
  let authenticated = false;
  const requests = [];
  const url = await fixture(t, socket => {
    socket.send(JSON.stringify({ type: 'auth_required' }));
    socket.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'auth') {
        authenticated = m.access_token === 'synthetic-test-token';
        socket.send(JSON.stringify({ type: 'auth_ok' }));
      } else {
        requests.push(m);
        if (requests.length === 2) for (const r of [...requests].reverse()) socket.send(JSON.stringify({ id: r.id, success: true, result: r.endpoint }));
      }
    });
  });
  const ha = await connectHA({ url, token: 'synthetic-test-token' }); t.after(ha.close);
  const results = await Promise.all([ha.call({ type: 'supervisor/api', endpoint: '/one' }), ha.call({ type: 'supervisor/api', endpoint: '/two' })]);
  assert.equal(authenticated, true); assert.deepEqual(results, ['/one', '/two']);
});

test('HA rejection never exposes remote response details', async t => {
  const url = await fixture(t, socket => {
    socket.send(JSON.stringify({ type: 'auth_ok' }));
    socket.on('message', raw => socket.send(JSON.stringify({ id: JSON.parse(raw).id, success: false, error: { message: 'private-response-fixture' } })));
  });
  const ha = await connectHA({ url, token: 'synthetic-test-token' }); t.after(ha.close);
  await assert.rejects(ha.call({ type: 'supervisor/api' }), error => /rejected/.test(error.message) && !error.message.includes('private-response-fixture'));
});

test('connection loss promptly rejects an in-flight rebuild as uncertain', async t => {
  const url = await fixture(t, socket => {
    socket.send(JSON.stringify({ type: 'auth_ok' }));
    socket.on('message', () => socket.close());
  });
  const ha = await connectHA({ url, token: 'synthetic-test-token' }); t.after(ha.close);
  await assert.rejects(ha.call({ type: 'supervisor/api', endpoint: '/addons/synthetic/rebuild' }), /may still be running/);
});

test('authentication timeout closes the connection', async t => {
  const url = await fixture(t, () => {});
  await assert.rejects(connectHA({ url, token: 'synthetic-test-token' }, { timeoutMs: 25 }), /authentication timed out/);
});

test('terminal handles fragmented frames, ignores banners and returns the exact exit status', async t => {
  let sentScript;
  const url = await fixture(t, socket => {
    socket.on('message', raw => {
      const text = raw.toString();
      if (text.startsWith('{')) { socket.send(Buffer.from('0private terminal banner\r\n')); return; }
      const marker = text.match(/DEPLOY_[a-f0-9]+/)[0];
      const encoded = text.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1];
      sentScript = Buffer.from(encoded, 'base64').toString();
      for (const part of [`\r\n${marker}_BEGIN\r\n`, 'safe res', `ult\r\n${marker}_END:`, '7\r\n']) socket.send(Buffer.from('0' + part));
    });
  }, (req, res) => {
    assert.equal(req.headers.cookie, 'ingress_session=synthetic-session');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token: 'synthetic-terminal-token' }));
  });
  const result = await runTerminal({ url, session: 'synthetic-session', ingress: '/api/hassio_ingress/synthetic' }, 'printf something');
  assert.equal(sentScript, 'printf something');
  assert.deepEqual(result, { exitCode: 7, output: 'safe result' });
});

test('terminal rejects external ingress addresses before making requests', async () => {
  await assert.rejects(runTerminal({ url: 'http://home-assistant.invalid', session: 'synthetic', ingress: '//external.invalid/path' }, 'true'), /Unexpected terminal ingress/);
});


test('deployment requires a stopped app, matching manifest version and running terminal', () => {
  const app = { state: 'stopped', version: '0.9.5-dev.3', repository: 'synthetic' };
  const manifest = { version: app.version };
  const terminal = { state: 'started' };
  assert.doesNotThrow(() => validateDeploymentState(app, manifest, terminal));
  for (const state of ['started', 'starting', 'unknown', undefined]) {
    assert.throws(() => validateDeploymentState({ ...app, state }, manifest, terminal), /Stop Home Energy/);
  }
  assert.throws(() => validateDeploymentState(app, { version: '0.9.6' }, terminal), /versions differ/);
  assert.throws(() => validateDeploymentState(app, manifest, { state: 'stopped' }), /Start Advanced/);
  assert.throws(() => validateDeploymentState({ ...app, repository: undefined }, manifest, terminal), /Git-backed/);
});
