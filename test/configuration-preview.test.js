import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigurationReviews, inheritConfigurationSnapshot, rememberConfigurationOptions } from '../src/app/configuration-preview.js';

function config(options, effective = {}) {
  const value = { input: 'simulated', topology: 'standalone', role: 'master',
    settings: { comfort: { maxDropC: options.controller?.max_drop_c ?? 1.5 } }, ...effective };
  rememberConfigurationOptions(value, options);
  return value;
}

test('source differences preserve configured field names and expose environment precedence', () => {
  const reviews = createConfigurationReviews();
  const before = config({ controller: { max_drop_c: 1.5 } });
  const after = config({ controller: { max_drop_c: 0.5 } }, { settings: before.settings });
  const review = reviews.preview(before, after);
  assert.deepEqual(review.changes, [
    { path: 'controller.max_drop_c', before: 1.5, after: 0.5, redacted: false },
    { path: 'effective.controller.max_drop_c', before: 1.5, after: 1.5, redacted: false },
  ]);
  assert.equal(Object.hasOwn(before, 'options'), false);
  assert.equal(Object.hasOwn(after, 'options'), false);
  reviews.consume(review.reviewId, before, after);
});

test('mirror and pair overrides show effective values in original units and conceal private endpoints', () => {
  const before = config({ mirror: { interval_seconds: 60 }, pair: { timeout_seconds: 3600, peer_url: 'http://synthetic-old.invalid' } },
    { mirror: { intervalMs: 60_000 }, pair: { timeoutMs: 3600_000, peerUrl: 'http://synthetic-environment.invalid' } });
  const after = config({ mirror: { interval_seconds: 120 }, pair: { timeout_seconds: 7200, peer_url: 'http://synthetic-new.invalid' } },
    { mirror: before.mirror, pair: before.pair });
  const review = createConfigurationReviews().preview(before, after);
  for (const [path, value] of [['effective.mirror.interval_seconds', 60], ['effective.pair.timeout_seconds', 3600]])
    assert.deepEqual(review.changes.find(row => row.path === path), { path, before: value, after: value, redacted: false });
  assert.equal(review.changes.find(row => row.path === 'effective.pair.peer_url').redacted, true);
  assert.doesNotMatch(JSON.stringify(review), /synthetic-(old|new|environment)/);
});

test('review tokens expire, evict oldest entries and reject mutated runtime or source snapshots', () => {
  let now = 0;
  const reviews = createConfigurationReviews({ clock: () => now, ttlMs: 1000, limit: 2 });
  const before = config({ controller: { max_drop_c: 1.5 } });
  const after = config({ controller: { max_drop_c: 0.5 } });
  const first = reviews.preview(before, after), second = reviews.preview(before, after);
  reviews.preview(before, after);
  assert.throws(() => reviews.consume(first.reviewId, before, after), /expired or settings changed/);
  now = 1000;
  assert.throws(() => reviews.consume(second.reviewId, before, after), /expired or settings changed/);
  const runtime = reviews.preview(before, after);
  after.token = 'synthetic-new-effective-token';
  assert.throws(() => reviews.consume(runtime.reviewId, before, after), /expired or settings changed/);
  const source = reviews.preview(before, after);
  rememberConfigurationOptions(after, { controller: { max_drop_c: 0.5 }, mqtt: { pw: 'synthetic-new-source-password' } });
  assert.throws(() => reviews.consume(source.reviewId, before, after), /expired or settings changed/);
});

test('equipment arrays, numeric identifiers and unknown field names cannot expose household details', () => {
  const before = config({ equipment: { devices: [] } });
  const after = config({ equipment: { devices: [{ id: 'synthetic-private-device', label: 'synthetic-private-label', area: 'garage',
    kind: 'switch', enabled: true, switch_id: 235, connection: 'mqtt:synthetic-private-topic' }] },
    ['synthetic-private-key']: 'synthetic-private-value' });
  const review = createConfigurationReviews().preview(before, after);
  assert.doesNotMatch(JSON.stringify(review), /synthetic-private|235/);
  assert.equal(review.changes.find(row => row.path === 'equipment.devices.0.area').after, 'garage');
  assert.equal(review.changes.find(row => row.path === 'equipment.devices.0.switch_id').redacted, true);
  assert.ok(review.changes.some(row => row.path === '[unsupported field]'));
});

test('pair runtime clones preserve source snapshots and unchanged reviewed reapply is available', () => {
  const original = config({ controller: { max_drop_c: 1.5 } });
  const before = inheritConfigurationSnapshot(original, { ...original, role: 'master' });
  const candidate = config({ controller: { max_drop_c: 0.5 } });
  const after = inheritConfigurationSnapshot(candidate, { ...candidate, role: 'master' });
  const reviews = createConfigurationReviews();
  assert.equal(reviews.preview(before, after).changes[0].path, 'controller.max_drop_c');
  const unchanged = reviews.preview(before, before);
  assert.deepEqual(unchanged.changes, []);
  assert.equal(unchanged.canApply, true);
});

test('optional HA broker review names its fields and conceals endpoint and independent credentials', () => {
  const before = config({ mqtt: { ha: {} } });
  const after = config({ mqtt: { ha: { address: 'mqtt://synthetic-private-ha.invalid:1885',
    user: 'synthetic-private-user', pw: 'synthetic-private-password' } } });
  const review = createConfigurationReviews().preview(before, after);
  assert.deepEqual(review.changes.map(row => row.path), ['mqtt.ha.address', 'mqtt.ha.user', 'mqtt.ha.pw']);
  assert(review.changes.every(row => row.redacted));
  assert.doesNotMatch(JSON.stringify(review), /synthetic-private/);
});
