import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('current native withdrawal diagnostics preserve evidence, calls, scope and privacy', () => {
  const script = fileURLToPath(new URL('./helpers/tuya-local-withdrawal-diagnostics.py', import.meta.url));
  assert.doesNotThrow(() => execFileSync('python3', [script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
  }));
});
