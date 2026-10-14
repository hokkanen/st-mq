import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('current native write failure preserves only later current unsent command entries', () => {
  const script = fileURLToPath(new URL('./helpers/tuya-local-write-command-retention.py', import.meta.url));
  assert.doesNotThrow(() => execFileSync('python3', [script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }));
});
