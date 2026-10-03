import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startConfigurationRecovery } from '../src/app/configuration-recovery.js';

async function fixture(t) {
  let now = 1000, persistCount = 0, nextPreparation = null;
  const source = {
    async recoveryInfo() { return { privatePath: '/fixture/secrets.json' }; },
    async prepare() {
      if (nextPreparation) {
        const preparation = nextPreparation;
        nextPreparation = null;
        preparation.entered.resolve();
        await preparation.release.promise;
      }
      return { reviewFingerprint: 'fixture-current-source', recoveryChanges: [],
        async persist() { persistCount++; } };
    },
  };
  const app = await startConfigurationRecovery({ source, error: new Error('Configuration must contain valid JSON.'),
    env: { STMQ_PORT: '0' }, clock: () => now, installSignalHandlers: false, log() {} });
  t.after(() => app.close());
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const html = await (await fetch(root)).text();
  const csrf = html.match(/name="recovery-csrf" content="([^"]+)"/)[1];
  const headers = { Authorization: `Bearer ${readFileSync(app.keyPath, 'utf8').trim()}`,
    'Content-Type': 'application/json', 'X-Recovery-CSRF': csrf };
  return {
    app,
    request: (path, value) => fetch(`${root}/api/recovery/${path}`, { method: 'POST', headers, body: JSON.stringify(value) }),
    advance(ms) { now += ms; },
    get persistCount() { return persistCount; },
    holdPreparation() {
      const pending = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      nextPreparation = pending;
      return pending;
    },
  };
}

test('expired recovery review cannot save and must be checked again', async t => {
  const f = await fixture(t);
  const review = await (await f.request('preview', { replacement: false })).json();
  f.advance(300_000);
  const expired = await f.request('apply', { reviewId: review.reviewId });
  assert.equal(expired.status, 409);
  assert.match((await expired.json()).error, /expired/);
  assert.equal(f.persistCount, 0);
  const fresh = await (await f.request('preview', { replacement: false })).json();
  assert.equal((await f.request('apply', { reviewId: fresh.reviewId })).status, 200);
  assert.equal(f.persistCount, 1);
});

test('concurrent recovery requests cannot replace a review while its source is being checked', async t => {
  const f = await fixture(t);
  const pending = f.holdPreparation();
  const first = f.request('preview', { replacement: false });
  await pending.entered.promise;
  assert.equal((await f.request('preview', { replacement: false })).status, 409);
  pending.release.resolve();
  const review = await (await first).json();
  assert.equal((await f.request('apply', { reviewId: review.reviewId })).status, 200);
  assert.equal(f.persistCount, 1);
});

test('shutdown during reviewed source validation prevents configuration persistence', async t => {
  const f = await fixture(t);
  const review = await (await f.request('preview', { replacement: false })).json();
  const pending = f.holdPreparation();
  // Closing the connection is expected; observe rejection immediately.
  const applying = f.request('apply', { reviewId: review.reviewId }).catch(() => null);
  await pending.entered.promise;
  await f.app.close();
  pending.release.resolve();
  await applying;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.persistCount, 0);
});
