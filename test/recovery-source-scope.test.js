import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { createDatabaseBackup } from '../src/storage/backup.js';
import { assessRecoverySource } from '../src/recovery/source-scope.js';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { recordLearningContext } from '../src/app/committed-learning.js';

const at = Date.parse('2026-01-01T00:00:00Z');
function observed(store, source) {
  store.observation({ source, device: 'invented-house', signal: 'indoor_temperature', unit: 'degC',
    value: 21, sourceTime: at, receivedAt: at });
}

test('source scope rejects known simulated/live mismatch but never claims household identity from format', t => {
  const donor = new Store(':memory:'); t.after(() => donor.close());
  assert.equal(assessRecoverySource(donor, 'mqtt').scope, 'unknown');
  observed(donor, 'simulation');
  assert.throws(() => assessRecoverySource(donor, 'mqtt'), { code: 'recovery_scope_mismatch' });
  assert.equal(assessRecoverySource(donor, 'simulated').scope, 'simulated');
  observed(donor, 'synthetic-physical');
  const mixed = assessRecoverySource(donor, 'mqtt');
  assert.equal(mixed.scope, 'mixed');
  assert.equal(mixed.installationIdentity, 'not-proven-by-format');
});

test('other current learning inputs are counted as skipped without translating their journal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-recovery-scope-'));
  const target = new Store(join(directory, 'target.sqlite')), donor = new Store(join(directory, 'donor.sqlite'));
  t.after(async () => { target.close(); donor.close(); await rm(directory, { recursive: true, force: true }); });
  recordLearningContext(donor, 'providers', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, at);
  observed(donor, 'synthetic-physical');
  const path = join(directory, 'backup.sqlite'); await createDatabaseBackup({ sourcePath: donor.path, destination: path });
  const preview = await recoveryPreview({ masterPath: target.path, donorPath: path, input: 'mqtt' });
  assert.equal(preview.sourceAssessment.scope, 'live');
  assert.deepEqual(preview.sourceAssessment.learningInputs, ['providers']);
  assert.equal(preview.sourceAssessment.skippedLearning.providers, 1);
  assert.equal(preview.tables.find(row => row.name === 'other_learning_inputs').count, 1);
  assert.equal(target.observations().length, 0);
  await recoverHistory({ store: target, donorPath: path, input: 'mqtt', preview,
    source: { kind: 'upload', label: 'Uploaded database' }, operationId: randomUUID() });
  assert.equal(target.observations().length, 1);
  assert.equal(target.learningJournal({ input: 'mqtt' }).length, 0);
  assert.equal(target.learningJournal({ input: 'providers' }).length, 0);
  assert.equal(donor.learningJournal({ input: 'providers' }).length, 1);
});

test('known source mismatch fails read-only checking before any target history is changed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-recovery-mismatch-'));
  const target = new Store(join(directory, 'target.sqlite')), donor = new Store(join(directory, 'donor.sqlite'));
  t.after(async () => { target.close(); donor.close(); await rm(directory, { recursive: true, force: true }); });
  observed(donor, 'simulation');
  const path = join(directory, 'backup.sqlite'); await createDatabaseBackup({ sourcePath: donor.path, destination: path });
  const before = await readFile(path);
  await assert.rejects(recoveryPreview({ masterPath: target.path, donorPath: path, input: 'mqtt' }), { code: 'recovery_scope_mismatch' });
  assert.deepEqual(await readFile(path), before);
  assert.equal(target.observations().length, 0);
  assert.equal(target.getState('recovery:active:mqtt'), null);
});
