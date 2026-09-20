import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttp } from '../src/acquisition/http.js';
import { fileTokenStore } from '../src/acquisition/token-store.js';

test('provider transport permits observations and auth only, refuses redirects and arbitrary origins', async () => {
  const calls = [];
  const http = createHttp({ fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}'); } });
  assert.deepEqual(await http.json('https://api.easee.com/state/example/observations'), { ok: true });
  assert.equal(calls[0].options.redirect, 'error');
  await http.json('https://api.easee.com/api/accounts/login', { method: 'POST', body: '{}' });
  for (const [url, options] of [
    ['https://attacker.invalid/?token=secret', {}], ['http://api.easee.com/', {}],
    ['https://api.easee.com/api/chargers/example/commands/start_charging', { method: 'POST' }],
    ['https://user:secret@api.easee.com/', {}], ['https://api.easee.com:444/', {}],
  ]) await assert.rejects(http.json(url, options));
  assert.equal(calls.length, 2);
});

test('provider errors preserve status but never URL, credentials or provider-echoed bodies', async () => {
  const http = createHttp({ fetchImpl: async () => new Response('secret-response-body', { status: 429 }) });
  await assert.rejects(http.json('https://api.easee.com/?token=secret'), error => error.status === 429 && !JSON.stringify(error).includes('secret'));
  const failed = createHttp({ fetchImpl: async () => { throw new Error('https://api.easee.com/?secret=token'); } });
  await assert.rejects(failed.json('https://api.easee.com'), /provider-network-error/);
});

test('body and lifetime bounds apply without Content-Length; pending requests stop on close', async () => {
  const oversized = createHttp({ maxBytes: 5, fetchImpl: async () => new Response('abcdef') });
  await assert.rejects(oversized.text('https://api.easee.com'), /too-large/);
  const broken = createHttp({ fetchImpl: async () => new Response('not JSON; secret=example') });
  await assert.rejects(broken.json('https://api.easee.com'), /invalid-provider-json/);
  const aborted = createHttp({ fetchImpl: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const request = aborted.json('https://api.easee.com');
  aborted.close();
  await assert.rejects(request, /aborted/);
  await assert.rejects(aborted.json('https://api.easee.com'), /closed/);
});

test('a provider deadline is distinguished from caller cancellation without exposing transport details', async () => {
  const http = createHttp({ timeoutMs: 10, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('synthetic-private-transport-detail')));
  }) });
  try {
    await assert.rejects(http.json('https://api.easee.com'), error =>
      error.code === 'provider-request-timeout' && !JSON.stringify(error).includes('synthetic-private'));
    const cancellation = new AbortController();
    const pending = http.json('https://api.easee.com', { signal: cancellation.signal });
    cancellation.abort();
    await assert.rejects(pending, error => error.code === 'provider-request-aborted');
  } finally { http.close(); }
});

test('rate-limit delays are bounded and preserved without response secrets', async () => {
  for (const [header, expected] of [['120', 120_000], ['9999999', 86400_000], ['invalid', null]]) {
    const http = createHttp({ fetchImpl: async () => new Response('secret', { status: 429, headers: { 'Retry-After': header } }) });
    await assert.rejects(http.text('https://api.open-meteo.com/data/2.5/weather?appid=secret'), error =>
      error.status === 429 && error.retryAfterMs === expected && !JSON.stringify(error).includes('secret'));
    http.close();
  }
});

test('rotating tokens persist privately without copying username/password or modifying other settings', t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-tokens-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tokens.json');
  const tokens = fileTokenStore(path);
  assert.equal(tokens.load(), null);
  tokens.save({ accessToken: 'access-one', refreshToken: 'refresh-one', password: 'never-store' });
  assert.deepEqual(tokens.load(), { accessToken: 'access-one', refreshToken: 'refresh-one' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8').includes('never-store'), false);
  tokens.save({ accessToken: 'access-two', refreshToken: 'refresh-two' });
  assert.equal(tokens.load().refreshToken, 'refresh-two');
});

test('rejected status and declared size cancel unread bodies', async () => {
  for (const options of [{ status: 503 }, { headers: { 'content-length': '900' } }]) {
    let cancelled = false;
    const http = createHttp({ maxBytes: 20, fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), options) });
    await assert.rejects(http.text('https://api.easee.com'));
    assert.equal(cancelled, true);
    http.close();
  }
});


test('Easee cached tokens are bound to configured credentials and legacy caches require a new login', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-account-token-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tokens.json');
  const pair = { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token' };
  fileTokenStore(path).save(pair);
  const credentials = { user: 'synthetic-account', pw: 'synthetic-password' };
  const bound = fileTokenStore(path, credentials);
  assert.equal(bound.load(), null);
  bound.save(pair);
  assert.deepEqual(fileTokenStore(path, credentials).load(), pair);
  assert.equal(fileTokenStore(path, { ...credentials, user: 'synthetic-other' }).load(), null);
  assert.equal(fileTokenStore(path, { ...credentials, pw: 'synthetic-rotated-password' }).load(), null);
  assert.equal(readFileSync(path, 'utf8').includes(credentials.pw), false);
});
