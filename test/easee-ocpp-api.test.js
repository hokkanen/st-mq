import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createAppServer } from '../src/app/server.js';
import { Store } from '../src/storage/store.js';

const token = 'fixture-ocpp-setup-api-token', revision = 'a'.repeat(64);
async function fixture(t, options = {}) {
  const store = new Store(':memory:'), calls = [];
  let current = { ocppSetup: { async adopt(value) { calls.push(value); return { state: 'connecting' }; } } };
  const server = createAppServer({ store, token, getEngine: () => current,
    chartService: { overview() {} }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/charging/ocpp-setup`;
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return { url, headers, calls, replace(value) { current = value; },
    post: (body = { action: 'adopt', revision }, extra = {}) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body), ...extra }) };
}

test('local charger adoption requires authentication, same-origin JSON, exact action and revision', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(undefined, { headers: {} })).status, 401);
  assert.equal((await f.post(undefined, { headers: { ...f.headers, Origin: 'https://fixture-other.invalid' } })).status, 403);
  for (const value of [null, [], {}, { action: 'adopt', revision: 'invalid' }, { action: 'reset', revision },
    { action: 'adopt', revision, endpoint: 'ws://fixture.invalid/ocpp' }]) assert.equal((await f.post(value)).status, 400);
  assert.deepEqual(f.calls, []);
  const response = await f.post(); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { setup: { state: 'connecting' } }); assert.deepEqual(f.calls, [revision]);
});

test('replica, protected controller and recovery reject OCPP adoption before dispatch', async t => {
  for (const [options, status] of [[{ role: 'replica' }, 405],
    [{ controlAuthority: { canControl: () => false } }, 409],
    [{ pairContext: { canControl: () => false, recovering: () => false } }, 409],
    [{ pairContext: { canControl: () => true, recovering: () => true } }, 409]]) {
    const f = await fixture(t, options); assert.equal((await f.post()).status, status); assert.deepEqual(f.calls, []);
  }
});

test('slow adoption bodies resolve the current runtime and authority only after parsing', async t => {
  let authority = true;
  const f = await fixture(t, { controlAuthority: { canControl: () => authority } });
  const body = JSON.stringify({ action: 'adopt', revision });
  let opened;
  const connected = new Promise(resolve => { opened = resolve; });
  const response = new Promise((resolve, reject) => {
    const req = request(f.url, { method: 'POST', headers: { ...f.headers, 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.write(body.slice(0, -1)); opened(req);
  });
  const req = await connected;
  authority = false; req.end(body.slice(-1));
  assert.equal(await response, 409); assert.deepEqual(f.calls, []);
});

test('stale setup and unexpected provider errors are presented without leaking private details', async t => {
  const f = await fixture(t);
  f.replace({ ocppSetup: { adopt() { throw Object.assign(new Error('fixture-private-url-and-password'), { code: 'ocpp-setup-changed', statusCode: 409 }); } } });
  let response = await f.post(); assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Review the current configuration/);
  f.replace({ ocppSetup: { adopt() { throw new Error('fixture-private-provider-body'); } } });
  response = await f.post(); assert.equal(response.status, 503);
  assert(!(await response.text()).includes('fixture-private'));
});
