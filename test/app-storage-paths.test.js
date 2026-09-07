import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { prepareStorage } from '../src/app/storage-paths.js';

test('HA migration copies committed WAL state to the public database and retains private credentials and original', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stmq-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data/st-mq'), dbPath = join(root, 'config/st-mq/st-mq.sqlite');
  const old = new Store(join(dataDir, 'st-mq.sqlite')); t.after(() => old.close());
  old.setState('preserved', { count: 42 });
  writeFileSync(join(dataDir, 'easee-tokens.json'), 'private-fixture');
  assert.equal(existsSync(`${old.path}-wal`), true);
  assert.deepEqual(await prepareStorage({ addon: true, dataDir, dbPath }), { from: old.path, to: dbPath, originalRetained: true });
  const migrated = new Store(dbPath); t.after(() => migrated.close());
  assert.deepEqual(migrated.getState('preserved'), { count: 42 });
  migrated.setState('preserved', { count: 43 });
  assert.equal(await prepareStorage({ addon: true, dataDir, dbPath }), null);
  assert.deepEqual(old.getState('preserved'), { count: 42 });
  assert.deepEqual(migrated.getState('preserved'), { count: 43 });
  assert.equal(readFileSync(join(dataDir, 'easee-tokens.json'), 'utf8'), 'private-fixture');
  assert.equal(existsSync(join(root, 'config/st-mq/easee-tokens.json')), false);
});

test('a corrupt migration source never creates an authoritative empty destination', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stmq-bad-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), dbPath = join(root, 'public/st-mq.sqlite');
  await prepareStorage({ addon: true, dataDir, dbPath });
  writeFileSync(join(dataDir, 'st-mq.sqlite'), 'broken database');
  await assert.rejects(prepareStorage({ addon: true, dataDir, dbPath }));
  assert.equal(existsSync(dbPath), false);
  assert.equal(readFileSync(join(dataDir, 'st-mq.sqlite'), 'utf8'), 'broken database');
});
