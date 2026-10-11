import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedRecoverySource, emptyRecoverySource, recoveryCheckpointChanged } from '../src/recovery/source-check.js';

const checkpoint = { databaseId: '00000000-0000-4000-8000-000000000001', sequence: 20, hash: 'a'.repeat(64) };
const preview = () => ({ status: 'checked', previewId: 'b'.repeat(64), donorDigest: checkpoint.hash,
  model: { status: 'not-assessed' }, incremental: { base: { ...checkpoint }, checkpoint: { ...checkpoint }, records: 0 },
  tables: [{ name: 'observations', count: 0 }], unsupported: [],
  sourceSummary: { categories: [{ name: 'temperatures', count: 0 }] }, sourceAssessment: { skippedLearningRecords: 0 } });

test('unchanged shared source is empty while its database may remain populated', () => {
  assert.equal(checkedRecoverySource(preview()), true);
  assert.equal(emptyRecoverySource(preview()), true);
});

test('an advanced checked source remains changed after deletion of every retained history row', () => {
  for (const records of [0, 1]) {
    const value = preview(); value.incremental.checkpoint = { ...checkpoint, sequence: 21, hash: 'c'.repeat(64) };
    value.incremental.records = records; value.donorDigest = value.incremental.checkpoint.hash;
    assert.equal(recoveryCheckpointChanged(value), true);
    assert.equal(emptyRecoverySource(value), false, 'Copy classification cannot authorize empty-source mirroring');
  }
  assert.equal(recoveryCheckpointChanged(preview()), false);
});

test('unknown or malformed source checkpoints cannot establish changed scope for zero history counts', () => {
  for (const change of [
    p => { delete p.incremental; }, p => { p.incremental = []; },
    p => { delete p.incremental.records; }, p => { p.incremental.records = '0'; },
    p => { p.incremental.records = -1; }, p => { p.incremental.extra = true; },
    p => { p.incremental.base = {}; }, p => { p.incremental.base.extra = true; },
    p => { p.incremental.checkpoint.hash = ''; }, p => { p.incremental.checkpoint.sequence = '21'; },
    p => { p.incremental.checkpoint.databaseId = '00000000-0000-4000-8000-000000000002'; },
    p => { p.incremental.checkpoint.sequence = 19; }, p => { p.donorDigest = checkpoint.hash; },
    p => { p.status = 'pending'; }, p => { p.counts = {}; }, p => { p.model.status = 'unchanged'; },
  ]) {
    const value = preview(); value.incremental.checkpoint = { ...checkpoint, sequence: 21, hash: 'c'.repeat(64) };
    value.donorDigest = value.incremental.checkpoint.hash; change(value);
    assert.equal(recoveryCheckpointChanged(value), false);
  }
  assert.equal(recoveryCheckpointChanged(null), false);
});

test('zero categories cannot hide actual changes, excluded rows or skipped learning', () => {
  for (const change of [
    p => { p.incremental.records = 1; },
    p => { p.incremental.checkpoint.sequence++; },
    p => { p.incremental.checkpoint.hash = 'c'.repeat(64); },
    p => { p.incremental.checkpoint.databaseId = '00000000-0000-4000-8000-000000000002'; },
    p => { p.tables[0].count = 1; },
    p => { p.unsupported = [{ name: 'charging_reports', count: 1 }]; },
    p => { p.sourceSummary.categories[0].count = 1; },
    p => { p.sourceAssessment.skippedLearningRecords = 1; },
    p => { p.donorDigest = 'c'.repeat(64); },
  ]) {
    const value = preview(); change(value);
    assert.equal(emptyRecoverySource(value), false);
  }
});

test('missing, invalid or already assessed evidence does not establish an empty source', () => {
  for (const change of [
    p => { delete p.incremental; },
    p => { delete p.incremental.records; },
    p => { p.incremental.base.sequence = -1; },
    p => { p.incremental.base.hash = ''; },
    p => { p.incremental.base.extra = true; },
    p => { p.incremental.extra = true; },
    p => { p.tables = []; },
    p => { p.tables[0].count = null; },
    p => { p.unsupported = null; },
    p => { p.sourceSummary = {}; },
    p => { p.sourceSummary.categories = []; },
    p => { p.status = 'complete'; },
    p => { p.model.status = 'unchanged'; },
    p => { p.counts = {}; },
    p => { p.previewId = ''; },
  ]) {
    const value = preview(); change(value);
    assert.equal(emptyRecoverySource(value), false);
  }
  assert.equal(emptyRecoverySource(null), false);
});
