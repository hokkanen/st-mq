import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings } from '../src/app/config.js';
import { finnishLocalInstant, temporaryUpdate } from '../src/app/temporary.js';

test('Finnish picker deadlines resolve winter/summer and reject DST gaps and repeated times', () => {
  assert.equal(finnishLocalInstant('2026-01-10T12:00'), Date.parse('2026-01-10T10:00Z'));
  assert.equal(finnishLocalInstant('2026-07-10T12:00'), Date.parse('2026-07-10T09:00Z'));
  assert.throws(() => finnishLocalInstant('2026-03-29T03:30'), /does not exist/);
  assert.throws(() => finnishLocalInstant('2026-10-25T03:30'), /occurs twice/);
  for (const value of ['2026-02-30T10:00', '2026-09-07T25:00', '', null, 123]) assert.throws(() => finnishLocalInstant(value));
  assert.equal(temporaryUpdate({ pauseUntil: '2026-10-25T03:30:00+02:00' }, Date.parse('2026-10-24T00:00Z')).pauseUntil,
    Date.parse('2026-10-25T01:30Z'));
});

test('temporary edit rejects unknown fields, ambiguous forms, past and excessive deadlines', () => {
  const now = Date.parse('2026-09-07T12:00Z');
  for (const value of [{}, [], null, { mode: 'active' }, { awayUntil: '2026-09-07T15:00' },
    { awayUntil: '2026-09-07T12:00Z' }, { pauseUntil: '2028-01-01T00:00Z' },
    { awayUntil: null, awayUntilLocal: null }, { pauseUntilLocal: '2026-09-07T14:00' }]) assert.throws(() => temporaryUpdate(value, now));
  assert.deepEqual(temporaryUpdate({ awayUntil: null }, now), { awayUntil: null });
});

test('away and pause are atomic, persistent, independent and expire without restoring old permanent settings', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = Date.parse('2026-09-07T12:00Z');
  const config = { input: 'offline', settings: validateSettings({ comfort: { maxDropC: 0.8 } }) };
  const engine = new Engine({ store, config, clock: () => now });
  const status = engine.setTemporary({ awayUntilLocal: '2026-09-10T17:00', pauseUntilLocal: '2026-09-08T10:00' });
  assert.equal(status.settings.occupancy.returnAt, '2026-09-10T14:00:00.000Z');
  assert.equal(status.override.expiresAt, Date.parse('2026-09-08T07:00Z'));
  assert.equal(engine.nextTemporaryDeadline(), Date.parse('2026-09-08T07:00Z'));
  assert.throws(() => engine.setTemporary({ awayUntil: null, pauseUntilLocal: '2026-03-29T03:30' }));
  assert.equal(engine.status().settings.occupancy.mode, 'away', 'Invalid combined edit did not cancel absence');
  store.setState('settings:offline', { comfort: { maxDropC: 2 }, occupancy: { mode: 'occupied' } });
  const restarted = new Engine({ store, config, clock: () => now });
  assert.equal(restarted.status().settings.comfort.maxDropC, 0.8);
  assert.equal(restarted.status().automation.home.enabled, false);
  assert.equal(restarted.status().settings.occupancy.mode, 'away');
  assert.equal(restarted.status().override.expiresAt, status.override.expiresAt);
  now = status.override.expiresAt;
  assert.equal(restarted.status().override, null, 'Reading status at the deadline reconciles expiry');
  assert.equal(restarted.status().settings.occupancy.mode, 'away');
  now = Date.parse(status.settings.occupancy.returnAt);
  assert.equal(restarted.status().settings.occupancy.mode, 'occupied');
  assert.equal(restarted.nextTemporaryDeadline(), Infinity);
  restarted.status();
  assert.equal(store.events().filter(e => e.type === 'occupancy-expired').length, 1);
  assert.equal(store.events().filter(e => e.type === 'override-expired').length, 1);
});

test('cancel one temporary control preserves the other and an expired saved absence is reconciled on startup', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = Date.parse('2026-09-07T12:00Z');
  const config = { input: 'offline', settings: validateSettings() };
  store.setState('occupancy:offline', { mode: 'away', returnAt: '2026-09-07T11:00Z' });
  const engine = new Engine({ store, config, clock: () => now });
  assert.equal(engine.tick().settings.occupancy.mode, 'occupied');
  engine.setTemporary({ awayUntilLocal: '2026-09-08T12:00', pauseUntilLocal: '2026-09-08T12:00' });
  assert.equal(engine.setTemporary({ awayUntil: null }).override.mode, 'normal');
  assert.equal(engine.status().settings.occupancy.mode, 'occupied');
  engine.setTemporary({ awayUntilLocal: '2026-09-08T12:00' });
  assert.equal(engine.setTemporary({ pauseUntil: null }).settings.occupancy.mode, 'away');
});
