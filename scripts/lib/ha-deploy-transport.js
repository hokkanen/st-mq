import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

export async function connectHA({ url, token }, { timeoutMs = 15000 } = {}) {
  const address = new URL('/api/websocket', url);
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(address);
  const pending = new Map();
  let next = 1, authenticated = false;
  let resolveAuth, rejectAuth;
  const ready = new Promise((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; });
  const fail = message => {
    clearTimeout(timer);
    rejectAuth(new Error(message));
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(message)); }
    pending.clear();
  };
  const timer = setTimeout(() => { fail('HA authentication timed out'); socket.terminate(); }, timeoutMs);
  socket.on('error', () => fail('HA WebSocket connection failed'));
  socket.on('close', () => fail('HA WebSocket closed; any submitted operation may still be running'));
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw); } catch { fail('Invalid HA WebSocket response'); socket.terminate(); return; }
    if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: token }));
    if (message.type === 'auth_ok') { authenticated = true; clearTimeout(timer); resolveAuth(); }
    if (message.type === 'auth_invalid') { fail('HA authentication rejected'); socket.close(); }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id); clearTimeout(job.timer);
    if (message.success) job.resolve(message.result);
    else job.reject(new Error('HA rejected the request; inspect Supervisor locally for details'));
  });
  try { await ready; } catch (error) { socket.terminate(); throw error; }
  return {
    close: () => socket.close(),
    call: (command, requestTimeoutMs = 30000) => new Promise((resolve, reject) => {
      if (!authenticated || socket.readyState !== WebSocket.OPEN) { reject(new Error('HA WebSocket is unavailable')); return; }
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('HA request timed out; the operation may still be running. Inspect Supervisor before retrying'));
      }, requestTimeoutMs + 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, ...command }));
    }),
  };
}

// Advanced SSH & Web Terminal's ttyd protocol. Output is returned only to the
// caller: terminal banners, failed commands and tokens must never be logged.
export async function connectTerminal({ url, session, ingress }, { timeoutMs = 30000 } = {}) {
  if (!/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/.test(ingress)) throw new Error('Unexpected terminal ingress path');
  const entry = ingress.replace(/\/$/, '');
  const cookie = `ingress_session=${session}`;
  let response;
  try {
    response = await fetch(new URL(entry + '/token', url), {
      headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new Error('Terminal authentication request failed'); }
  if (!response.ok) throw new Error('Terminal authentication rejected');
  let token;
  try { token = (await response.json()).token; } catch { throw new Error('Invalid terminal authentication response'); }
  if (typeof token !== 'string') throw new Error('Missing terminal authentication token');
  const address = new URL(entry + '/ws', url);
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(address, ['tty'], { headers: { Cookie: cookie, Origin: new URL(url).origin } });
  let active = null, failure = null, startupDelay;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = message => {
    if (failure) return;
    failure = new Error(message);
    clearTimeout(startupTimer); clearTimeout(startupDelay); clearInterval(heartbeat);
    rejectReady(failure);
    if (active) { clearTimeout(active.timer); active.reject(failure); active = null; }
    // A timed-out or disconnected command must never be replayed on a new socket.
    socket.terminate();
  };
  const startupTimer = setTimeout(() => fail('Terminal connection timed out'), timeoutMs);
  // Rebuilds can take 15 minutes without terminal commands. Keep the connection
  // active through ingress/proxies without sending shell input or replaying work.
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, 20000);
  heartbeat.unref();
  socket.on('error', () => fail('Terminal WebSocket failed; any submitted command may still be running'));
  socket.on('close', () => fail('Terminal closed; any submitted command may still be running'));
  socket.on('open', () => socket.send(JSON.stringify({ AuthToken: token, columns: 120, rows: 40 })));
  socket.on('message', data => {
    const buffer = Buffer.from(data);
    if (buffer[0] !== 48) return;
    // Allow the initial terminal banner/prompt to settle once per connection.
    if (!startupDelay) startupDelay = setTimeout(() => { clearTimeout(startupTimer); resolveReady(); }, 400);
    const job = active;
    if (!job) return;
    job.output += buffer.subarray(1).toString('utf8');
    if (job.output.length > 2 * 1024 * 1024) { fail('Terminal output exceeded its limit'); return; }
    const clean = job.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    const begin = '\n' + job.marker + '_BEGIN\n';
    const start = clean.indexOf(begin);
    if (start < 0) return;
    // ttyd/tmux may repaint completion directly after unterminated output.
    const end = clean.indexOf(job.marker + '_END:', start + begin.length);
    if (end < 0) return;
    const code = clean.slice(end).match(/_END:(\d+)\n/);
    if (!code) return;
    clearTimeout(job.timer); active = null;
    job.resolve({ exitCode: Number(code[1]), output: clean.slice(start + begin.length, end).replace(/\n$/, '') });
  });
  await ready;
  return {
    close: () => fail('Terminal connection closed'),
    run: (script, { timeoutMs: commandTimeoutMs = 30000 } = {}) => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Terminal WebSocket is unavailable')); return; }
      if (active) { reject(new Error('A terminal command is already running')); return; }
      const marker = 'DEPLOY_' + randomBytes(12).toString('hex');
      const encoded = Buffer.from(script).toString('base64');
      const timer = setTimeout(() => fail('Terminal timed out; the remote command may still be running'), commandTimeoutMs);
      active = { marker, output: '', timer, resolve, reject };
      // Restore echo before acknowledging completion, so the next command can
      // start immediately without racing the previous command's terminal setup.
      const command = `(stty -echo; printf '\\n${marker}_BEGIN\\n'; printf '%s' '${encoded}' | base64 -d | sh; deploy_status=$?; stty echo; printf '\\n${marker}_END:%s\\n' "$deploy_status")\r`;
      socket.send(Buffer.concat([Buffer.from('0'), Buffer.from(command)]), error => {
        if (error) fail('Terminal send failed; the remote command may still be running');
      });
    }),
  };
}
