import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { Store } from '../src/storage/store.js';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { fixture, observation, start } from './helpers/recovery-fixture.js';

for (const open of [true, false]) test(`a ${open ? 'live' : 'closed'} WAL donor is rejected without modifying either history`, async t => {
  const f = fixture(t), donor = new Store(join(f.directory,'unrelated.sqlite'));
  t.after(()=>{try{donor.close();}catch{}});
  observation(donor, start);
  const donorPath = donor.path;
  if (!open) donor.close();
  const donorBefore = await readFile(donorPath), stateBefore = f.master.db.prepare('SELECT * FROM state').all();
  await assert.rejects(recoveryPreview({ masterPath: f.master.path, donorPath, signal: t.signal }),
    { code: 'recovery_source_not_snapshot' });
  assert.deepEqual(await readFile(donorPath), donorBefore);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM state').all(), stateBefore);
  assert.equal(f.master.observations().length, 0);
});

test('a source-only check reports exporter identity and a changed export requires a fresh review', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(donor, start);
  const donorPath = join(f.directory, 'portable-export.sqlite');
  await donor.backup(donorPath);
  const files = await readdir(f.directory);
  const preview = await recoveryPreview({ masterPath: f.master.path, donorPath, signal: t.signal });
  assert.equal(preview.status, 'checked');
  assert.equal(preview.model.status, 'not-assessed');
  assert.equal(preview.counts, undefined);
  assert.equal(preview.sourceSoftware.format, 1);
  assert(Number.isSafeInteger(preview.sourceSoftware.exportedAt));
  assert.deepEqual(await readdir(f.directory), files, 'Checking creates no candidate database');
  observation(donor, start + 1000, 22);
  const changed = await f.snapshot(donor);
  await assert.rejects(recoverHistory({ store: f.master, donorPath: changed, preview, signal: t.signal }), { code: 'recovery_invalid' });
  assert.equal(f.master.observations().length, 0);
});
