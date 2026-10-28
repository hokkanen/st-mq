import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkDocumentation } from '../scripts/check-docs.js';

function check(t, files, untracked = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stmq-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return checkDocumentation({ root, paths: Object.keys(files) });
}

test('documentation links resolve public files, images, directories and heading identities', t => {
  const result = check(t, {
    'README.md': '[guide](docs/guide.md#room--zero) ![icon](icon.svg) [docs](docs/) [root](/README.md#start)\n# Start',
    'icon.svg': '<svg/>',
    'docs/guide.md': '# Room & `zero`\n# Repeat\n# Repeat\n<a id="explicit"></a>\n'
      + '[duplicate](#repeat-1) [explicit](#explicit) [self](#room--zero)\n'
      + '[unicode](other%20guide.md#lämpö) [title](../README.md "Start page")',
    'docs/other guide.md': '# Lämpö',
  });
  assert.deepEqual(result, { files: 3, links: 9, errors: [] });
});

test('documentation failures identify source lines and reject local-only or escaped targets', t => {
  const result = check(t, { 'README.md': '# Guide\n[missing](gone.md)\n[anchor](#absent)\n'
    + '[ignored](local.md)\n[escape](../outside.md)\n[encoding](bad%zz.md)' }, { 'local.md': '# Local' });
  assert.deepEqual(result.errors, [
    'README.md:2: target is not versioned: gone.md',
    'README.md:3: missing heading or anchor: #absent',
    'README.md:4: target is not versioned: local.md',
    'README.md:5: target is not versioned: ../outside.md',
    'README.md:6: invalid URL encoding: bad%zz.md',
  ]);
});

test('fenced examples and external destinations do not create offline checks or anchors', t => {
  const result = check(t, { 'README.md': '# Guide\n```md\n[example](missing.md)\n# Example\n```\n'
    + '~~~md\n[example](other.md)\n~~~\n[web](https://example.invalid) [mail](mailto:fixture@example.invalid)\n'
    + '[missing heading](#example)' });
  assert.equal(result.links, 1);
  assert.deepEqual(result.errors, ['README.md:10: missing heading or anchor: #example']);
});
