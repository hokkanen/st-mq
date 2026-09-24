import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { createRuntimeTiming } from '../../src/app/runtime-timing.js';

test('default SQLite contention delays the independent timer and is exposed by runtime timing', async t => {
  const directory = mkdtempSync(join(tmpdir(),'stmq-storage-latency-'));
  const store = new Store(join(directory,'fixture.sqlite')), writer = new DatabaseSync(store.path);
  const timing = createRuntimeTiming();
  t.after(() => { timing.close(); writer.close(); store.close(); rmSync(directory,{recursive:true,force:true}); });
  await new Promise(resolve => setTimeout(resolve,40));
  writer.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  const independentTimer = new Promise(resolve => setTimeout(() => resolve(performance.now()-started),1));
  try { assert.throws(() => store.setState('fixture',{value:1}), error => error.errcode === 5); }
  finally { writer.exec('ROLLBACK'); }
  const timerDelayMs = await independentTimer;
  await new Promise(resolve => setTimeout(resolve,40));
  assert.ok(timerDelayMs >= 4000, 'The default durable write wait is explicitly measured, not hidden by a test-only timeout');
  assert.ok(timing.status().maxObservedDelayMs >= 4000);
  assert.equal(timing.status().hardRealtime,false);
  assert.equal(store.getState('fixture'),null);
  store.setState('fixture',{value:2}); assert.deepEqual(store.getState('fixture'),{value:2});
  t.diagnostic(JSON.stringify({timerDelayMs:Math.round(timerDelayMs),...timing.status()}));
});
