import test from 'node:test';
import assert from 'node:assert/strict';
import { garagePausePermission } from '../src/garage/permission.js';

const now = 1_800_000_000_000, minute = 60_000;
const args = { now, observation: { rearAt: now, frontAt: now },
  protection: { requiredFresh: true, safeToPause: true, interventionAt: null }, heatingDelayMs: 2 * minute };

test('permission follows the older supporting report rather than renewal time', () => {
  const permission = garagePausePermission({ ...args, observation: { rearAt: now, frontAt: now - minute / 2 } });
  assert.equal(permission.allowed, true);
  assert.equal(permission.expiresAt, now + 1.5 * minute);
  assert.equal(permission.evidenceAt, now - minute / 2);
  assert.equal(garagePausePermission({ ...args, observation: { rearAt: now, frontAt: now - 2 * minute } }).allowed, false);
});

test('the host caps OFF at two minutes even when the driver supports three', () => {
  const permission = garagePausePermission({ ...args, maxLeaseMs: 3 * minute });
  assert.equal(permission.allowed, true);
  assert.equal(permission.expiresAt, now + 2 * minute);
  const reconsidered = garagePausePermission({ ...args, now: now + minute / 2, maxLeaseMs: 3 * minute });
  assert.equal(reconsidered.allowed, true);
  assert.equal(reconsidered.expiresAt, permission.expiresAt);
  const shorterDriver = garagePausePermission({ ...args, maxLeaseMs: 1.5 * minute });
  assert.equal(shorterDriver.allowed, true);
  assert.equal(shorterDriver.expiresAt, now + 1.5 * minute);
});

test('new permission needs enough time for revalidation and cannot use held transport evidence', () => {
  assert.equal(garagePausePermission({ ...args, now: now + minute - 1 }).allowed, true);
  const late = garagePausePermission({ ...args, now: now + minute });
  assert.equal(late.allowed, false);
  assert.equal(late.reason, 'restoration-margin-exhausted');
  for (const location of ['rear', 'front']) {
    const result = garagePausePermission({ ...args, observation: { ...args.observation, [`${location}Held`]: true } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'fresh-temperature-reserve-required');
  }
});

test('thermal reserve shortens a lease and includes useful heating delay once', () => {
  const permission = garagePausePermission({ ...args,
    protection: { ...args.protection, interventionAt: now + 4 * minute } });
  assert.equal(permission.allowed, true);
  assert.equal(permission.expiresAt, now + 2 * minute - 1);
  assert.equal(garagePausePermission({ ...args,
    protection: { ...args.protection, interventionAt: now + 3 * minute } }).allowed, false);
});

test('unknown heating response, missing sensors and unsafe reserve cannot authorize a pause', () => {
  for (const patch of [{ heatingDelayMs: null }, { heatingDelayMs: NaN }, { observation: { rearAt: now } },
    { observation: { rearAt: now + 1, frontAt: now + 1 } },
    { observation: { rearAt: now + 1, frontAt: now } },
    { observation: { rearAt: now, frontAt: now + 1 } },
    { protection: { ...args.protection, requiredFresh: false } },
    { protection: { ...args.protection, safeToPause: false } }])
    assert.equal(garagePausePermission({ ...args, ...patch }).allowed, false);
});
