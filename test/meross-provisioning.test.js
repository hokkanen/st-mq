import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Meross broker preparation preserves private files and binding cannot operate doors', () => {
  assert.doesNotThrow(() => execFileSync('python3', [fileURLToPath(new URL('./helpers/meross-provisioning.py', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }));
});
