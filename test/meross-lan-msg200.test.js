import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Meross LAN MSG200 uses the matching contact and preserves reviewed source updates', () => {
  const script = fileURLToPath(new URL('./helpers/meross-lan-msg200.py', import.meta.url));
  assert.doesNotThrow(() => execFileSync('python3', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
});
