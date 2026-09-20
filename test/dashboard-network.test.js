import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationUrl, usesHomeAssistantLogin, authenticationMessage, createPollingRequest } from '../chart/network.js';
import { chartQuery } from '../chart/history-model.js';

test('dashboard requests retain the Home Assistant ingress prefix for reads and mutations', () => {
  const base = 'https://home.example/api/hassio_ingress/example-session/';
  for (const path of ['/api/status', '/api/events?after=4&limit=50', '/api/settings/reload',
    '/api/fireplace', '/api/fireplace/remove', '/api/temporary', '/api/heating-test',
    '/api/test/h66', '/api/recording-overview', '/api/energy-audits',
    chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'power' }),
    'share/st-mq/easee.csv', './share/st-mq/st-mq.csv']) {
    const url = new URL(applicationUrl(path, base));
    assert.equal(url.origin, 'https://home.example');
    assert.ok(url.pathname.startsWith('/api/hassio_ingress/example-session/'));
    assert.equal(url.search, new URL(path, 'https://example.invalid').search);
  }
});

test('standalone API paths remain local with root and index document URLs', () => {
  for (const base of ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234/index.html']) {
    assert.equal(applicationUrl('/api/status', base), 'http://127.0.0.1:1234/api/status');
  }
});

test('ingress login errors direct users back to Home Assistant without requesting an application token', () => {
  assert.equal(usesHomeAssistantLogin('/api/hassio_ingress/example-session/'), true);
  assert.equal(usesHomeAssistantLogin('/api/hassio_ingress/example-session/index.html'), true);
  for (const path of ['/', '/index.html', '/api/status', '/api/hassio_ingress/']) assert.equal(usesHomeAssistantLogin(path), false);
  assert.match(authenticationMessage(true), /Reopen ST-MQ from the host dashboard/);
  assert.doesNotMatch(authenticationMessage(true), /access token/);
  assert.match(authenticationMessage(false), /access token/);
});

test('slow status reads survive repeated timer polls without accumulating requests', async () => {
  const requests = [];
  const poll = createPollingRequest(() => new Promise(resolve => requests.push(resolve)));
  const first = poll();
  await Promise.resolve();
  for (let interval = 0; interval < 10; interval++) assert.equal(poll({ background: true }), null);
  assert.equal(requests.length, 1);
  requests[0]({ ready: true });
  assert.deepEqual(await first, { ready: true });
  const next = poll({ background: true });
  await Promise.resolve();
  assert.equal(requests.length, 2, 'Polling resumes as soon as the status fetch settles');
  requests[1]({ ready: true });
  await next;
});

test('explicit login refresh can supersede a pending status read and failures release polling', async () => {
  const requests = [];
  const poll = createPollingRequest(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  const beforeLogin = poll({ background: true });
  const afterLogin = poll();
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[0].resolve({ authenticated: false });
  await beforeLogin;
  assert.equal(poll({ background: true }), null, 'An obsolete response cannot release a newer pending read');
  const failed = assert.rejects(afterLogin, /temporarily unavailable/);
  requests[1].reject(new Error('temporarily unavailable'));
  await failed;
  const retried = poll({ background: true });
  await Promise.resolve();
  assert.equal(requests.length, 3);
  requests[2].resolve({ authenticated: true });
  assert.deepEqual(await retried, { authenticated: true });
});
