import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';
import { createWebSessions, WEB_SESSIONS_KEY, REMEMBERED_LOGIN_MS, REMEMBERED_LOGIN_COOKIE,
  rememberedCookie, rememberedCookieDigest } from '../src/app/web-sessions.js';
import { createWebSession } from '../chart/web-access.js';
import { PairManager } from '../src/pairing/manager.js';

const ADMIN = 'synthetic-remembered-admin-password';
const FAMILY = 'synthetic-remembered-family-password';
const INITIAL = Date.parse('2026-10-20T12:00:00Z');
const cookie = issued => `${REMEMBERED_LOGIN_COOKIE}=${issued.token}`;
const hash = issued => rememberedCookieDigest({ socket: { encrypted: true }, headers: { cookie: cookie(issued) } });
function fixture(t, options = {}) {
  const store = options.store ?? new Store(':memory:');
  if (!options.store) t.after(() => store.close());
  let now = INITIAL, access = { enabled: true, token: ADMIN, familyToken: FAMILY }, writable = true;
  const service = createWebSessions({ store, getAccess: () => access, clock: () => now, writable: () => writable, ...options });
  return { store, service, clock: () => now, getAccess: () => access,
    time: value => { now = value; }, access: value => { access = value; }, writable: value => { writable = value; } };
}

test('remembered sessions keep their original 360-day boundary without renewal or raw credentials in storage', async t => {
  const f = fixture(t), issued = await f.service.issue('admin'), id = hash(issued);
  const before = JSON.stringify(f.store.getState(WEB_SESSIONS_KEY));
  assert.equal(issued.expiresAt, INITIAL + REMEMBERED_LOGIN_MS);
  for (const forbidden of [issued.token, ADMIN, FAMILY]) assert.equal(before.includes(forbidden), false);
  f.time(issued.expiresAt - 1);
  assert.equal((await f.service.authenticate(id)).expiresAt, issued.expiresAt);
  assert.equal(f.service.identity(id).role, 'admin');
  assert.equal(JSON.stringify(f.store.getState(WEB_SESSIONS_KEY)), before, 'Reads never save or extend a session');
  f.time(issued.expiresAt);
  assert.equal(await f.service.authenticate(id), null);
  assert.equal(f.service.identity(id), null);
  const replacement = await f.service.issue('admin');
  assert.equal(replacement.expiresAt, issued.expiresAt + REMEMBERED_LOGIN_MS);
});

test('logout revokes only its token; password rotation revokes its role and cannot revive on changing back', async t => {
  const f = fixture(t), first = await f.service.issue('admin'), second = await f.service.issue('admin'), family = await f.service.issue('family');
  await f.service.revoke(hash(first));
  assert.equal(await f.service.authenticate(hash(first)), null);
  assert.equal(f.service.identity(hash(second)).role, 'admin');
  const next = { enabled: true, token: ADMIN, familyToken: 'synthetic-new-family-password' };
  await f.service.credentialsChanged(next); f.access(next);
  assert.equal(await f.service.authenticate(hash(family)), null);
  assert.equal(f.service.identity(hash(second)).role, 'admin');
  f.access({ enabled: true, token: ADMIN, familyToken: FAMILY });
  assert.equal(await f.service.authenticate(hash(family)), null);
  await f.service.revokeAll(hash(second));
  assert.equal(await f.service.authenticate(hash(second)), null);
});

test('committed tokens survive reopening the current database and standby mutations use the active peer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-session-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(() => store.close());
  const options = { getAccess: () => ({ token: ADMIN, familyToken: FAMILY }), clock: () => INITIAL };
  let master = createWebSessions({ ...options, store });
  const issued = await master.issue('family');
  store.close(); store = new Store(path); master = createWebSessions({ ...options, store });
  assert.equal(master.identity(hash(issued)).role, 'family');
  let peerAvailable = true;
  const standby = createWebSessions({ ...options, store: { readOnly: true,
    getState() { throw Error('Must not authorize from replica state'); }, runWrite() { throw Error('Must not write a replica'); } },
    peer: { request: input => { if (!peerAvailable) throw Error('Offline'); return master.perform(input); } } });
  const admin = await standby.issue('admin');
  assert.equal(standby.identity(hash(admin), await standby.authenticate(hash(admin))).role, 'admin');
  await standby.revoke(hash(admin));
  assert.equal(standby.identity(hash(admin), await standby.authenticate(hash(admin))), null);
  peerAvailable = false;
  await assert.rejects(standby.authenticate(hash(issued)), { statusCode: 503 });
});

test('unknown state, failed commits and authority loss never create remembered access', async t => {
  const f = fixture(t);
  f.store.setState(WEB_SESSIONS_KEY, { version: 0, sessions: [] });
  const before = JSON.stringify(f.store.getState(WEB_SESSIONS_KEY));
  await assert.rejects(f.service.issue('admin'), { statusCode: 503 });
  assert.equal(JSON.stringify(f.store.getState(WEB_SESSIONS_KEY)), before);
  const failing = createWebSessions({ store: { runWrite: async () => { throw Error('Commit failed'); } },
    getAccess: f.getAccess, clock: f.clock });
  await assert.rejects(failing.issue('admin'), { statusCode: 503 });
  let writable = true;
  // Exercise dispatch and queued admission independently of controller hardware.
  const queued = createWebSessions({ store: { runWrite: async operation => { writable = false; return operation(); } },
    getAccess: f.getAccess, writable: () => writable });
  await assert.rejects(queued.issue('admin'), { statusCode: 503 });
});

test('host-prefixed cookies are HTTPS-only, reject duplicates and remembered browser state contains no password', () => {
  const issued = { token: 'a'.repeat(43), expiresAt: INITIAL + REMEMBERED_LOGIN_MS };
  assert.match(rememberedCookie(issued.token, issued.expiresAt), /; Path=\/; Secure; HttpOnly; SameSite=Strict; Expires=/);
  assert.doesNotMatch(rememberedCookie(issued.token, issued.expiresAt), /Domain=|Max-Age=/);
  assert.equal(rememberedCookieDigest({ socket: {}, headers: { cookie: cookie(issued), 'x-forwarded-proto': 'https' } }), null);
  assert.equal(rememberedCookieDigest({ socket: { encrypted: true }, headers: { cookie: `${cookie(issued)}; ${cookie(issued)}` } }), null);
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const session = createWebSession({ storage }); session.login(ADMIN); session.useRemembered();
  assert.equal(session.token, ''); assert.equal(session.locked, false); assert.equal(values.has('stmq-token'), false);
});

test('pair session requests require the active master and retain current input validation', async t => {
  const f = fixture(t), issued = await f.service.issue('admin');
  let calls = 0, active = true;
  const manager = { state: { value: {} }, canControl: () => active,
    hooks: { webSession: input => { calls++; return f.service.perform(input); } } };
  const input = { action: 'authenticate', digest: hash(issued) };
  assert.equal((await PairManager.prototype.handlePeer.call(manager, 'web-session', input)).role, 'admin');
  active = false;
  await assert.rejects(PairManager.prototype.handlePeer.call(manager, 'web-session', input), { code: 'not_master' });
  assert.equal(calls, 1, 'A standby cannot run session mutations or authenticate a delayed local record');
  active = true;
  await assert.rejects(PairManager.prototype.handlePeer.call(manager, 'web-session', { ...input, version: 0 }), { statusCode: 400 });
  await assert.rejects(f.service.revokeAll(hash(issued) + '0'), { statusCode: 400 });
});

test('real TLS login enforces origin, password, role, revocation and cookie expiry on the server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-session-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const key = await readFile(join(directory, 'key.pem')), cert = await readFile(join(directory, 'cert.pem'));
  const f = fixture(t), server = createAppServer({ store: f.store, getAccess: f.getAccess, webSessions: f.service,
    tls: { key, cert }, clock: f.clock, chartService: {}, pairContext: { canControl: () => true, status: () => ({ role: 'master' }) } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const request = httpsRequest(`${origin}${path}`, { method, ca: cert, headers }, response => {
      let data = ''; response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(data) }));
    });
    request.on('error', reject); request.end(body);
  });
  const post = (path, token, extra = {}, body = '{}') => send(path, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body });
  assert.equal((await post('/api/session/remember', ADMIN, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post('/api/session/remember', ADMIN, { Origin: '' })).status, 403);
  assert.equal((await post('/api/session/remember', 'wrong-password')).status, 401);
  assert.equal((await post('/api/session/remember', ADMIN, {}, '{"days":999}')).status, 400);
  const family = await post('/api/session/remember', FAMILY);
  assert.equal(family.status, 200);
  const familyCookie = family.headers['set-cookie'][0].split(';')[0];
  const view = await send('/api/pair', { headers: { Cookie: familyCookie } });
  assert.equal(view.status, 200); assert.equal(view.data.webAccess.role, 'family');
  assert.equal(view.headers['set-cookie'], undefined, 'Activity cannot renew the cookie');
  assert.equal((await post('/api/session/remember', null, { Cookie: familyCookie })).status, 401, 'A cookie cannot start another 360-day period');
  assert.equal((await post('/api/session/revoke-all', null, { Cookie: familyCookie })).status, 403);
  const admin = await post('/api/session/remember', ADMIN), adminCookie = admin.headers['set-cookie'][0].split(';')[0];
  assert.equal((await post('/api/session/logout', null, { Cookie: familyCookie })).status, 200);
  assert.equal((await send('/api/pair', { headers: { Cookie: familyCookie } })).status, 401);
  assert.equal((await send('/api/pair', { headers: { Cookie: adminCookie } })).status, 200);
  assert.equal((await post('/api/session/revoke-all', null, { Cookie: adminCookie })).status, 200);
  assert.equal((await send('/api/pair', { headers: { Cookie: adminCookie } })).status, 401);
  const expiring = await post('/api/session/remember', ADMIN), expiringCookie = expiring.headers['set-cookie'][0].split(';')[0];
  f.time(expiring.data.expiresAt);
  assert.equal((await send('/api/pair', { headers: { Cookie: expiringCookie } })).status, 401);
});

test('HTTP never issues or accepts a remembered cookie even with spoofed proxy HTTPS', async t => {
  const f = fixture(t), issued = await f.service.issue('admin');
  const server = createAppServer({ store: f.store, getAccess: f.getAccess, webSessions: f.service, chartService: {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${ADMIN}`, Origin: base, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' };
  for (const action of ['remember', 'logout', 'revoke-all']) {
    const response = await fetch(`${base}/api/session/${action}`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403); assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal((await fetch(`${base}/api/pair`, { headers: { Cookie: cookie(issued) } })).status, 401);
});
