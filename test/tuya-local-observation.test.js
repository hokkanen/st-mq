import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('pinned Tuya Local adapter and atomic installer pass source-level synthetic checks', () => {
  const script = fileURLToPath(new URL('./helpers/tuya-local-observation.py', import.meta.url));
  assert.doesNotThrow(() => execFileSync('python3', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
});
