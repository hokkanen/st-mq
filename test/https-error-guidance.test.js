import test from 'node:test';
import assert from 'node:assert/strict';
import { errorCode } from '../src/https/storage.js';

test('storage refusals expose actionable safe codes without native paths or messages', () => {
  for (const [native, expected] of Object.entries({ ENOSPC: 'https_storage_full', EDQUOT: 'https_storage_full',
    EACCES: 'https_storage_permission_denied', EPERM: 'https_storage_permission_denied',
    EROFS: 'https_storage_read_only', EXDEV: 'https_storage_cross_device' })) {
    const error = Object.assign(new Error('synthetic-private-value at /synthetic/private/identity'), { code: native, path: '/synthetic/private/identity' });
    assert.equal(errorCode(error), expected);
    assert.doesNotMatch(errorCode(error), /synthetic|private|identity/);
  }
  assert.equal(errorCode({ code: 'https_pair_identity_changed' }), 'https_pair_identity_changed');
  assert.equal(errorCode(new Error('synthetic-private-value')), 'https_operation_failed');
  assert.equal(errorCode({ code: 'native code with private text' }), 'https_operation_failed');
  assert.equal(errorCode({ code: Symbol('synthetic-private-value') }), 'https_operation_failed');
  assert.equal(errorCode({ code: 'constructor' }), 'constructor');
});
