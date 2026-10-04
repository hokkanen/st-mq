import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { connectHA, connectTerminal, shellQuote } from '../scripts/lib/ha-deploy-transport.js';
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

async function terminalFixture(t, onCommand, { banner = true } = {}) {
  const requests = { token: 0, socket: 0, commands: 0 };
  let connection;
  const url = await fixture(t, socket => {
    requests.socket++;
    connection = socket;
    socket.on('message', raw => {
      const text = raw.toString();
      if (text.startsWith('{')) {
        assert.equal(JSON.parse(text).AuthToken, 'synthetic-terminal-token');
        if (banner) socket.send(Buffer.from('0private terminal banner\r\n'));
        return;
      }
      assert.equal(text[0], '0');
      requests.commands++;
      onCommand(socket, text.slice(1));
    });
  }, (req, res) => {
    assert.equal(req.url, '/api/hassio_ingress/synthetic/token');
    assert.equal(req.headers.cookie, 'ingress_session=synthetic-session');
    requests.token++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'synthetic-terminal-token' }));
  });
  return {
    context: { url, session: 'synthetic-session', ingress: '/api/hassio_ingress/synthetic' },
    requests,
    get socket() { return connection; },
  };
}

function terminalResult(socket, command, output = '', exitCode = 0) {
  const marker = 'DEPLOY_' + command.match(/deploy_marker="([a-f0-9]+)"/)[1];
  socket.send(Buffer.from(`0\r\n${marker}_BEGIN!\r\n${output}\r\n${marker}_END:${exitCode}:DONE!\r\n`));
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

for (const trailingNewline of [true, false]) test(`terminal handles fragmented frames and exit status with trailing newline ${trailingNewline}`, async t => {
  const sentScripts = [];
  const markers = new Set();
  let priorResult;
  const server = await terminalFixture(t, (socket, command) => {
    const marker = 'DEPLOY_' + command.match(/deploy_marker="([a-f0-9]+)"/)[1];
    const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1];
    markers.add(marker);
    sentScripts.push(Buffer.from(encoded, 'base64').toString());
    socket.send(Buffer.from('1ignored ttyd control frame'));
    if (priorResult) socket.send(Buffer.from('0' + priorResult));
    const result = `\r\n${marker}_BEGIN!\r\n\x1b[32msafe result ${sentScripts.length}\x1b[0m${trailingNewline ? '\r\n' : ''}${marker}_END:7:DONE!\r\n`;
    for (let offset = 0; offset < result.length; offset += 5) socket.send(Buffer.from('0' + result.slice(offset, offset + 5)));
    socket.send(Buffer.from('0private prompt after completion\r\n'));
    priorResult = result;
  });
  const terminal = await connectTerminal(server.context); t.after(terminal.close);
  for (let i = 1; i <= 3; i++) {
    assert.deepEqual(await terminal.run(`printf something${i}`), { exitCode: 7, output: `safe result ${i}` });
  }
  assert.deepEqual(sentScripts, ['printf something1', 'printf something2', 'printf something3']);
  assert.equal(markers.size, 3);
  assert.deepEqual(server.requests, { token: 1, socket: 1, commands: 3 });
});

test('terminal rejects external ingress addresses before making requests', async () => {
  await assert.rejects(connectTerminal({ url: 'http://home-assistant.invalid', session: 'synthetic', ingress: '//external.invalid/path' }), /Unexpected terminal ingress/);
});

test('terminal accepts tmux cursor redraws without newline delimiters and ignores command echo', async t => {
  const server = await terminalFixture(t, (socket, command) => {
    const marker = 'DEPLOY_' + command.match(/deploy_marker="([a-f0-9]+)"/)[1];
    assert.ok(!command.includes(marker), 'echo must not contain a complete result marker');
    socket.send(Buffer.from('0' + command));
    // tmux redraws the terminal screen using cursor positioning instead of LF.
    const result = `\x1b[38;1H${marker}_BEGIN!\x1b[39;1Hsynthetic result${marker}_END:12:DONE!\x1b[39;6H`;
    for (let offset = 0; offset < result.length; offset += 3) socket.send(Buffer.from('0' + result.slice(offset, offset + 3)));
  });
  const terminal = await connectTerminal(server.context); t.after(terminal.close);
  for (let i = 0; i < 3; i++) assert.deepEqual(await terminal.run('exit 12'), { exitCode: 12, output: 'synthetic result' });
  assert.equal(server.requests.socket, 1);
});

test('terminal reconstructs a synthetic chunked upload over one authenticated connection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ha-deployment-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = await terminalFixture(t, (socket, command) => {
    // Execute the actual shell framing and payload, replacing only the terminal
    // echo operation because this offline fixture uses pipes instead of a PTY.
    assert.ok(Buffer.byteLength(command) < 4096, 'each command fits the terminal input line');
    const output = execFileSync('sh', ['-c', `stty() { :; }; ${command.replace(/\r$/, '\n')}`], { cwd: directory });
    socket.send(Buffer.concat([Buffer.from('0'), output]));
  });
  const terminal = await connectTerminal(server.context); t.after(terminal.close);
  const bytes = Buffer.from(Array.from({ length: 96 * 1024 }, (_, i) => i % 256));
  const encoded = bytes.toString('base64');
  const start = performance.now();
  assert.equal((await terminal.run(': > upload.b64')).exitCode, 0);
  let chunks = 0;
  for (let offset = 0; offset < encoded.length; offset += 1600) {
    const result = await terminal.run(`test "$(wc -c < upload.b64)" -eq ${offset} && printf '%s' '${encoded.slice(offset, offset + 1600)}' >> upload.b64`);
    assert.deepEqual(result, { exitCode: 0, output: '' });
    chunks++;
  }
  const result = await terminal.run('base64 -d upload.b64 > upload.bin && sha256sum upload.bin');
  const elapsedMs = performance.now() - start;
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(result, { exitCode: 0, output: `${expectedHash}  upload.bin\n` });
  assert.deepEqual(readFileSync(join(directory, 'upload.bin')), bytes);
  assert.deepEqual(server.requests, { token: 1, socket: 1, commands: chunks + 2 });
  t.diagnostic(`${chunks} chunks transferred in ${elapsedMs.toFixed(0)} ms after connection; removed per-chunk waits alone previously required ${chunks * 400} ms. Loopback fixture timing is not an HA throughput measurement.`);
});

for (const failure of ['timeout', 'close', 'output limit']) test(`terminal ${failure} rejects active and future commands without reconnecting`, async t => {
  const server = await terminalFixture(t, socket => {
    if (failure === 'close') socket.close();
    if (failure === 'output limit') socket.send(Buffer.from('0' + 'x'.repeat(2 * 1024 * 1024 + 1)));
  });
  const terminal = await connectTerminal(server.context); t.after(terminal.close);
  const closed = once(server.socket, 'close');
  const expected = failure === 'output limit' ? /output exceeded its limit/ : /may still be running/;
  await assert.rejects(terminal.run('synthetic command', { timeoutMs: 150 }), expected);
  await closed;
  await assert.rejects(terminal.run('must never be sent'), expected);
  assert.deepEqual(server.requests, { token: 1, socket: 1, commands: 1 });
});

test('terminal rejects concurrent commands without disturbing the active command', async t => {
  let finish;
  const received = new Promise(resolve => { finish = resolve; });
  const server = await terminalFixture(t, (socket, command) => finish({ socket, command }));
  const terminal = await connectTerminal(server.context); t.after(terminal.close);
  const first = terminal.run('first command');
  const pending = await received;
  await assert.rejects(terminal.run('overlapping command'), /already running/);
  terminalResult(pending.socket, pending.command, 'first result');
  assert.deepEqual(await first, { exitCode: 0, output: 'first result' });
  assert.deepEqual(server.requests, { token: 1, socket: 1, commands: 1 });
});

test('terminal startup timeout closes a connection that never produces output', async t => {
  const server = await terminalFixture(t, () => assert.fail('startup failure must not send commands'), { banner: false });
  await assert.rejects(connectTerminal(server.context, { timeoutMs: 150 }), /connection timed out/);
  if (server.socket.readyState !== server.socket.CLOSED) await once(server.socket, 'close');
  assert.deepEqual(server.requests, { token: 1, socket: 1, commands: 0 });
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
