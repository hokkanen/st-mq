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
export async function runTerminal({ url, session, ingress }, script, { timeoutMs = 30000 } = {}) {
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
  const marker = 'DEPLOY_' + randomBytes(12).toString('hex');
  const encoded = Buffer.from(script).toString('base64');
  return new Promise((resolve, reject) => {
    let output = '', sent = false, done = false, sendTimer;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(sendTimer); socket.close();
      error ? reject(new Error(error)) : resolve(result);
    };
    const timer = setTimeout(() => finish('Terminal timed out; the remote command may still be running'), timeoutMs);
    socket.on('error', () => finish('Terminal WebSocket failed'));
    socket.on('close', () => finish('Terminal closed before command completion'));
    socket.on('open', () => socket.send(JSON.stringify({ AuthToken: token, columns: 120, rows: 40 })));
    socket.on('message', data => {
      const buffer = Buffer.from(data);
      if (buffer[0] !== 48) return;
      output += buffer.subarray(1).toString('utf8');
      if (output.length > 2 * 1024 * 1024) { finish('Terminal output exceeded its limit'); return; }
      if (!sent) {
        sent = true;
        sendTimer = setTimeout(() => {
          if (done) return;
          const command = `stty -echo; printf '\\n${marker}_BEGIN\\n'; printf '%s' '${encoded}' | base64 -d | sh; printf '\\n${marker}_END:%s\\n' "$?"; stty echo\r`;
          socket.send(Buffer.concat([Buffer.from('0'), Buffer.from(command)]));
        }, 400);
      }
      const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
      const begin = '\n' + marker + '_BEGIN\n';
      const start = clean.indexOf(begin);
      if (start < 0) return;
      // ttyd/tmux may repaint the completion marker directly after output
      // that has no trailing newline. The random marker is the delimiter.
      const end = clean.indexOf(marker + '_END:', start + begin.length);
      if (end < 0) return;
      const code = clean.slice(end).match(/_END:(\d+)\n/);
      if (code) finish(null, { exitCode: Number(code[1]), output: clean.slice(start + begin.length, end).replace(/\n$/, '') });
    });
  });
}
