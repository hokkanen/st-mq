import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
test('current journal and cycle assessments reopen without duplicate source rows', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-current-learning-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.sqlite'); let store = new Store(path);
  const sample = { timestamp: 900000, indoorC: 21, outdoorC: 0, phase: 'normal', regime: 'occupied', quality: [] };
  const id = appendLearningRecord(store, 'mqtt', 'sample', sample);
  assert.equal(appendLearningRecord(store, 'mqtt', 'sample', sample), id);
  const checkpoint = replayLearningJournal(store, 'mqtt');
  store.cycle('mqtt', { id: 'fixture-cycle', startedAt: 1000, status: 'active' });
  store.close(); store = new Store(path);
  try {
    assert.deepEqual(replayLearningJournal(store, 'mqtt', checkpoint), checkpoint);
    assert.equal(store.learningJournal({ input: 'mqtt' }).length, 1);
    assert.equal(store.cycles({ input: 'mqtt', completedOnly: true }).length, 0);
    store.cycle('mqtt', { id: 'fixture-cycle', startedAt: 1000, endedAt: 900000, status: 'completed', assessment: { profitCents: -12 } });
    assert.equal(store.cycles({ input: 'mqtt', completedOnly: true })[0].assessment.profitCents, -12);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE name='learning_samples'").get(), undefined);
  } finally { store.close(); }
});
