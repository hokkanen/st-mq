import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/storage/store.js';
import { importCsvInWorker } from '../src/storage/import-service.js';

const run = promisify(execFile);
function fixture(t, rows = 4000) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-csv-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'st-mq.csv'), databasePath = join(directory, 'history.sqlite');
  const source = 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n'
    + Array.from({ length: rows }, (_, i) => `${1701842400 + i * 60},-4.2,60,21.3,NaN,-5.3\n`).join('');
  writeFileSync(file, source);
  return { file, databasePath, source, rows };
}

test('CLI CSV import retains a large atomic publication with source bytes, units, missing values and idempotency', async t => {
  const f = fixture(t);
  const args = ['scripts/history.js', 'import', '--file', f.file, '--kind', 'stmq', '--db', f.databasePath];
  const { stdout } = await run(process.execPath, args, { cwd: new URL('..', import.meta.url), timeout: 60000 });
  const result = JSON.parse(stdout);
  assert.equal(result.rows, f.rows); assert.equal(result.rejected, 0);
  const store = new Store(f.databasePath, { readOnly: true });
  try {
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, f.rows * 5);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM import_rows').get().n, f.rows);
    const saved = store.db.prepare("SELECT value,unit,source_time FROM observations WHERE signal='spot_price' ORDER BY id LIMIT 1").get();
    assert.deepEqual({ ...saved }, { value: -4.2, unit: 'c/kWh_ex_vat', source_time: 1701842400000 });
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM observations WHERE signal='garage_temperature' AND value IS NULL").get().n, f.rows);
    const commit = store.db.prepare('SELECT MAX(bytes) bytes FROM journal_commits').get();
    assert(commit.bytes > 4 * 1024 * 1024, 'The fixture must actually exceed the controller-thread publication bound');
  } finally { store.close(); }
  const again = JSON.parse((await run(process.execPath, args, { cwd: new URL('..', import.meta.url), timeout: 60000 })).stdout);
  assert.equal(again.skipped, true); assert.equal(again.importId, result.importId);
  assert.equal(readFileSync(f.file, 'utf8'), f.source);
});

test('cancelled worker import joins before retry and leaves partial staging hidden', async t => {
  const f = fixture(t), cancellation = new AbortController();
  let progressCalls = 0;
  await assert.rejects(importCsvInWorker({ ...f, kind: 'stmq', signal: cancellation.signal,
    onProgress() { progressCalls++; cancellation.abort(new Error('synthetic cancellation')); } }), /synthetic cancellation/);
  assert(progressCalls > 0);
  const partial = new Store(f.databasePath, { readOnly: true });
  try {
    assert.equal(partial.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
    assert.equal(partial.db.prepare("SELECT COUNT(*) n FROM imports WHERE status='complete'").get().n, 0);
  } finally { partial.close(); }
  const result = await importCsvInWorker({ ...f, kind: 'stmq' });
  assert.equal(result.rows, f.rows);
  const completed = new Store(f.databasePath, { readOnly: true });
  try {
    assert.equal(completed.db.prepare('SELECT COUNT(*) n FROM observations').get().n, f.rows * 5);
    assert.equal(completed.db.prepare('SELECT COUNT(*) n FROM imports').get().n, 1);
  } finally { completed.close(); }
  assert.equal(readFileSync(f.file, 'utf8'), f.source);
});

test('worker importer preserves validation and progress callback errors', async t => {
  const f = fixture(t, 1000);
  await assert.rejects(importCsvInWorker({ ...f, kind: 'unsupported' }), /Import kind/);
  await assert.rejects(importCsvInWorker({ ...f, kind: 'stmq', onProgress() { throw new Error('synthetic progress error'); } }), /synthetic progress error/);
  assert.equal(readFileSync(f.file, 'utf8'), f.source);
});
