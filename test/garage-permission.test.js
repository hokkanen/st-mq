import test from 'node:test';
import assert from 'node:assert/strict';
import { garagePausePermission } from '../src/garage/permission.js';

const now = 1_800_000_000_000, minute = 60_000;
const args = { now, observation: { rearAt: now, frontAt: now },
  protection: { requiredFresh: true, safeToPause: true, interventionAt: null }, heatingDelayMs: 2 * minute };

test('permission follows the older supporting report rather than renewal time', () => {
  const permission = garagePausePermission({ ...args, observation: { rearAt: now, frontAt: now - minute } });
  assert.equal(permission.allowed, true);
  assert.equal(permission.expiresAt, now + 2 * minute);
  assert.equal(permission.evidenceAt, now - minute);
  assert.equal(garagePausePermission({ ...args, observation: { rearAt: now, frontAt: now - 2 * minute } }).allowed, false);
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
