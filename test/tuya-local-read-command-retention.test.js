import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('current native status-read failure preserves only current queued command entries', () => {
  const script = fileURLToPath(new URL('./helpers/tuya-local-read-command-retention.py', import.meta.url));
  assert.doesNotThrow(() => execFileSync('python3', [script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }));
});
