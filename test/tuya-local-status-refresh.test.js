import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('current native withdrawal refresh is bounded and preserves source and command ownership', () => {
  const script = fileURLToPath(new URL('./helpers/tuya-local-status-refresh.py', import.meta.url));
  assert.doesNotThrow(() => execFileSync('python3', [script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }));
});
