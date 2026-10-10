import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { LearningCheckpointCache } from '../src/app/learning-checkpoint-cache.js';
import { replayLearningJournal, learningCheckpointDigest } from '../src/app/committed-learning.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { sample, start, W } from './helpers/recovery-fixture.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';

function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-checkpoint-cache-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const cache = new LearningCheckpointCache({ store, input: 'mqtt', ...options });
  t.after(async () => { await cache.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const checkpoint = window => {
    sample(store, start + window * W);
    return replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
  };
  return { store, cache, checkpoint };
}

test('cache snapshots a committed boundary, permits later inputs and atomically captures sparse replay state', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1), expected = structuredClone(first);
  assert.equal(cache.save(first), true);
  first.model.parameters.syntheticMutation = true;
  const latest = checkpoint(2);
  await cache.flush();
  assert.deepEqual(store.getState('adaptive:mqtt'), expected, 'the saved snapshot retains its original boundary despite later inputs');
  assert.equal(cache.status().saved, 1);
  const sparse = store.db.prepare('SELECT journal_cursor,payload FROM learning_checkpoints').all();
  assert.equal(sparse.length, 1);
  assert.equal(sparse[0].journal_cursor, expected.journalCursor);
  assert.deepEqual(JSON.parse(sparse[0].payload), expected);
  const reopened = new Store(store.path, { readOnly: true });
  try {
    assert.deepEqual(replayLearningJournal(reopened, 'mqtt', reopened.getState('adaptive:mqtt'),
      { persistCheckpoint: false }), latest, 'restart replays the intact suffix after a lagging cache');
  } finally { reopened.close(); }
});

test('current offline learning scope can save and reconstruct its checkpoint cache', async t => {
  const { store, cache } = setup(t, { input: 'offline' });
  appendLearningRecord(store, 'offline', 'sample', { timestamp: start + W, windowStart: start, windowEnd: start + W,
    indoorC: 21, outdoorC: 0, phase: 'normal', targetC: 21, regime: 'occupied', quality: [] }, { config: {} });
  const checkpoint = replayLearningJournal(store, 'offline', null, { rebuild: true, persistCheckpoint: false });
  assert.equal(cache.save(checkpoint), true);
  await cache.flush();
  assert.deepEqual(store.getState('adaptive:offline'), checkpoint);
  assert.equal(store.getState('adaptive:mqtt'), null);
});

test('rollback and discarded nested saves never enqueue checkpoint writes', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1);
  assert.throws(() => store.transaction(() => { cache.save(first); throw new Error('rollback'); }), /rollback/);
  await cache.settled();
  assert.equal(cache.worker, null);
  assert.equal(store.getState('adaptive:mqtt'), null);
  store.transaction(() => {
    cache.save(first);
    assert.throws(() => store.transaction(() => { cache.save(checkpoint(2)); throw new Error('nested'); }), /nested/);
  });
  await cache.settled();
  assert.equal(store.getState('adaptive:mqtt'), null, 'discarding the latest optional cache cannot publish a rolled-back boundary');
  assert.equal(store.learningJournalHead('mqtt'), first.journalCursor);
});

test('multiple committed saves coalesce to one latest pending snapshot', async t => {
  const { store, cache, checkpoint } = setup(t);
  let latest;
  store.transaction(() => {
    for (let window = 1; window <= 6; window++) { latest = checkpoint(window); cache.save(latest); }
    assert.equal(cache.worker, null, 'worker starts only after the outer transaction commits');
    assert.equal(cache.status().pending, true);
  });
  latest = checkpoint(7); cache.save(latest);
  await cache.flush();
  assert.deepEqual(store.getState('adaptive:mqtt'), latest);
  assert.equal(cache.status().saved, 1, 'worker startup retains only the latest committed snapshot');
  assert.equal(store.learningJournal({ input: 'mqtt' }).length, 7);
});

for (const changed of ['epoch', 'history selection', 'fireplace revision', 'sensor revision'])
test(`queued cache rejects changed ${changed}`, async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1);
  store.transaction(() => {
    cache.save(first);
    if (changed === 'epoch') store.db.prepare("INSERT INTO learning_epochs(input,epoch) VALUES('mqtt','invented-new-epoch')").run();
    else if (changed === 'history selection') store.db.prepare("UPDATE history_selection SET generation='invented-new-selection' WHERE id=1").run();
    else if (changed === 'fireplace revision') store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','invented-fireplace',?,'load',3)").run(start);
    else {
      const change = addSensorChange(store, 'mqtt', { signal: 'indoor_temperature', reason: 'replacement',
        requestId: 'invented-sensor' }, start + 2 * W);
      revertSensorChange(store, 'mqtt', { id: change.id, requestId: 'invented-revert' }, start + 3 * W);
    }
  });
  await cache.flush();
  assert.equal(store.getState('adaptive:mqtt'), null);
  assert.equal(cache.status().skipped, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM learning_checkpoints').get().n, 0);
});

test('cache rejects a different database identity before opening a writable target', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1), before = store.checkpoint(), original = store.checkpoint;
  store.checkpoint = () => ({ ...before, databaseId: randomUUID() });
  try { cache.save(first); } finally { store.checkpoint = original; }
  await cache.flush();
  assert.equal(cache.status().status, 'failed');
  assert.equal(store.getState('adaptive:mqtt'), null);
  assert.deepEqual(store.checkpoint(), before);
});

test('old source interpretation cannot be queued under a new correction revision', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1);
  store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','invented-fireplace',?,'load',3)").run(start);
  assert.equal(cache.save(first), false);
  await cache.flush();
  assert.equal(cache.worker, null);
  assert.equal(store.getState('adaptive:mqtt'), null);
});

test('cache cannot rewind or replace an already saved current-epoch checkpoint at the same boundary', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1), latest = checkpoint(2);
  store.setState('adaptive:mqtt', latest);
  const before = store.checkpoint();
  cache.save(first); await cache.flush();
  cache.save(latest); await cache.flush();
  assert.equal(cache.status().skipped, 2);
  assert.deepEqual(store.getState('adaptive:mqtt'), latest);
  assert.deepEqual(store.checkpoint(), before);
});

test('verified already-current worker result clears a prior warning without rewriting the cache', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1), latest = checkpoint(2);
  cache.save({ ...latest, checkpointDigest: 'invalid' }); await cache.flush();
  assert.equal(cache.status().status, 'failed');
  store.setState('adaptive:mqtt', latest);
  const before = store.checkpoint();
  cache.save(first); await cache.flush();
  assert.equal(cache.status().error, null);
  assert.equal(cache.status().status, 'current');
  assert.equal(cache.status().journalCursor, latest.journalCursor);
  assert.equal(cache.status().saved, 0);
  assert.equal(cache.status().skipped, 1);
  assert.deepEqual(store.checkpoint(), before);
});

test('an older valid cache cannot clear a failed newer boundary through worker or inline confirmation', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1), latest = checkpoint(2);
  store.setState('adaptive:mqtt', first);
  cache.save({ ...latest, checkpointDigest: 'invalid' }); await cache.flush();
  cache.save(first); await cache.flush();
  assert(cache.status().error);
  cache.confirmCommitted(first);
  assert(cache.status().error);
  store.transaction(() => {
    store.setState('adaptive:mqtt', latest);
    cache.confirmCommitted(latest);
    assert(cache.status().error, 'confirmation must wait for the outer commit');
  });
  assert.equal(cache.status().error, null);
  assert.equal(cache.status().journalCursor, latest.journalCursor);
});

test('rolled-back inline publication retains the warning until the corrected cache really commits', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); store.setState('adaptive:mqtt', first);
  const latest = checkpoint(2);
  cache.save({ ...latest, checkpointDigest: 'invalid' }); await cache.flush();
  assert.throws(() => store.transaction(() => {
    store.setState('adaptive:mqtt', latest); cache.confirmCommitted(latest);
    throw new Error('rollback');
  }), /rollback/);
  assert(cache.status().error);
  assert.deepEqual(store.getState('adaptive:mqtt'), first);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => {
      store.setState('adaptive:mqtt', latest); cache.confirmCommitted(latest);
      throw new Error('nested rollback');
    }), /nested rollback/);
  });
  assert(cache.status().error);
  store.transaction(() => { store.setState('adaptive:mqtt', latest); cache.confirmCommitted(latest); });
  assert.equal(cache.status().error, null);
});

test('committed empty corrected history clears an obsolete cache warning', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); store.setState('adaptive:mqtt', first);
  cache.save({ ...first, checkpointDigest: 'invalid' }); await cache.flush();
  assert(cache.status().error);
  store.transaction(() => {
    store.db.prepare("INSERT INTO learning_epochs(input,epoch) VALUES('mqtt','empty-corrected-epoch')").run();
    store.setState('adaptive:mqtt', null); cache.confirmCommitted(null);
    assert(cache.status().error);
  });
  assert.equal(cache.status().error, null);
  assert.equal(cache.status().journalCursor, 0);
  assert.equal(store.learningJournalHead('mqtt'), 0);
});

for (const invalid of ['remaining history', 'remaining checkpoint', 'rollback'])
test(`empty checkpoint confirmation retains a warning with ${invalid}`, async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); store.setState('adaptive:mqtt', first); cache.fail();
  const publish = () => store.transaction(() => {
    if (invalid !== 'remaining history')
      store.db.prepare("INSERT INTO learning_epochs(input,epoch) VALUES('mqtt','empty-corrected-epoch')").run();
    if (invalid !== 'remaining checkpoint') store.setState('adaptive:mqtt', null);
    cache.confirmCommitted(null);
    if (invalid === 'rollback') throw new Error('rollback');
  });
  if (invalid === 'rollback') assert.throws(publish, /rollback/); else publish();
  assert(cache.status().error);
});

for (const changed of ['epoch', 'history selection', 'source revision', 'digest', 'expected snapshot'])
test(`inline confirmation does not clear a warning after changed ${changed}`, async t => {
  const { store, cache, checkpoint } = setup(t);
  const value = checkpoint(1); cache.fail();
  store.transaction(() => {
    store.setState('adaptive:mqtt', value); cache.confirmCommitted(value);
    if (changed === 'epoch') store.db.prepare("INSERT INTO learning_epochs(input,epoch) VALUES('mqtt','different-epoch')").run();
    else if (changed === 'history selection') store.db.prepare("UPDATE history_selection SET generation='different-selection' WHERE id=1").run();
    else if (changed === 'source revision')
      store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','new-source',?,'load',3)").run(start);
    else if (changed === 'digest') store.setState('adaptive:mqtt', { ...value, journalHash: 'invalid' });
    else store.setState('adaptive:mqtt', checkpoint(2));
  });
  assert(cache.status().error);
});

test('a changed source interpretation is not proof that a rejected worker cache succeeded', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); cache.fail();
  cache.save(first);
  store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','changed-source',?,'load',3)").run(start);
  await cache.flush();
  assert(cache.status().error);
  assert.equal(cache.status().skipped, 1);
  const corrected = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
  store.setState('adaptive:mqtt', corrected); cache.confirmCommitted(corrected);
  assert.equal(cache.status().error, null);
});

for (const corrected of [false, true])
test(`late worker failure cannot resurrect a warning after ${corrected ? 'corrected' : 'newer'} inline publication`, async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); cache.save(first); await cache.flush();
  const second = checkpoint(2);
  let latest = checkpoint(3);
  store.transaction(() => {
    cache.save(second);
    store.afterCommit(() => {
      assert.equal(cache.status().active, true);
      store.transaction(() => {
        if (corrected) {
          store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','corrected-source',?,'load',3)").run(start);
          latest = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
        }
        store.setState('adaptive:mqtt', latest); cache.confirmCommitted(latest);
      });
      cache.worker.emit('error', new Error('delayed failure of superseded request'));
    });
  });
  await cache.flush();
  assert.equal(cache.status().error, null);
  assert.equal(cache.status().status, 'current');
  assert.deepEqual(store.getState('adaptive:mqtt'), latest);
});

test('delayed older worker success cannot rewind a newer confirmed publication', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); cache.save(first); await cache.flush();
  const second = checkpoint(2), latest = checkpoint(3);
  store.transaction(() => {
    cache.save(second);
    store.afterCommit(() => {
      const id = cache.active.id;
      store.transaction(() => {
        store.setState('adaptive:mqtt', latest); cache.confirmCommitted(latest);
      });
      // Delivery may lag the worker commit while the main thread publishes a
      // newer cache. Exercise the actual result listener in that ordering.
      cache.worker.emit('message', { type: 'result', id, status: 'saved', journalCursor: second.journalCursor });
    });
  });
  await cache.flush();
  assert.equal(cache.status().error, null);
  assert.equal(cache.status().journalCursor, latest.journalCursor);
  assert.equal(cache.confirmation.journalCursor, latest.journalCursor);
});

test('same-head corrected source replaces an older interpretation and rejects an older queued snapshot', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); store.setState('adaptive:mqtt', first);
  cache.save(first);
  store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','invented-fireplace',?,'load',3)").run(start);
  const corrected = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
  assert.equal(corrected.journalCursor, first.journalCursor);
  assert.notEqual(corrected.fireplaceRevision, first.fireplaceRevision);
  await cache.flush();
  assert.deepEqual(store.getState('adaptive:mqtt'), first, 'old queued source is rejected after its fence changes');
  cache.save(corrected); await cache.flush();
  assert.deepEqual(store.getState('adaptive:mqtt'), corrected, 'equal journal cursor cannot retain a superseded source interpretation');
  assert.equal(cache.save(first), false);
  assert.deepEqual(store.getState('adaptive:mqtt'), corrected);
});

test('valid replay repairs a corrupt saved model at the same immutable journal boundary', async t => {
  const { store, cache, checkpoint } = setup(t);
  const expected = checkpoint(1), corrupt = structuredClone(expected);
  corrupt.model.parameters.syntheticCorruption = true;
  store.setState('adaptive:mqtt', corrupt);
  assert.equal(cache.save(expected), true);
  await cache.flush();
  assert.equal(cache.status().saved, 1);
  assert.deepEqual(store.getState('adaptive:mqtt'), expected);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), expected);
});

for (const initial of ['null', 'current empty seed'])
test(`verified journal checkpoint replaces ${initial} without interpreting it as learning history`, async t => {
  const { store, cache, checkpoint } = setup(t);
  let seed = null;
  if (initial === 'current empty seed') {
    seed = restoreAdaptiveCheckpoint(null);
    seed.fireplaceRevision = 0;
    seed.checkpointDigest = learningCheckpointDigest(seed);
  }
  store.setState('adaptive:mqtt', seed);
  const expected = checkpoint(1);
  assert.equal(cache.save(expected), true);
  await cache.flush();
  assert.equal(cache.status().saved, 1);
  assert.deepEqual(store.getState('adaptive:mqtt'), expected);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), expected);
});

for (const algorithmVersion of ['invented-retired-algorithm', null])
test(`explicit unsupported algorithm ${String(algorithmVersion)} cannot be overwritten as an empty cache`, async t => {
  const { store, cache, checkpoint } = setup(t);
  const expected = checkpoint(1), unsupported = { ...expected, algorithmVersion };
  store.setState('adaptive:mqtt', unsupported);
  const before = store.checkpoint();
  cache.save(expected); await cache.flush();
  assert.equal(cache.status().status, 'failed');
  assert.deepEqual(store.getState('adaptive:mqtt'), unsupported);
  assert.deepEqual(store.checkpoint(), before);
});

test('invalid checkpoint failure preserves prior cache and journal without leaking payload details', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); store.setState('adaptive:mqtt', first);
  const latest = checkpoint(2), before = store.checkpoint();
  cache.save({ ...latest, checkpointDigest: 'invented-private-payload' });
  await cache.flush();
  assert.equal(cache.status().status, 'failed');
  assert.equal(cache.status().failed, 1);
  assert(!JSON.stringify(cache.status()).includes('invented-private-payload'));
  assert.deepEqual(store.getState('adaptive:mqtt'), first);
  assert.deepEqual(store.checkpoint(), before);
  cache.save(latest); await cache.flush();
  assert.equal(cache.status().status, 'current');
  assert.equal(cache.status().error, null);
  assert.deepEqual(store.getState('adaptive:mqtt'), latest);
});

test('serialization failure cannot throw through an otherwise committed controller transaction', async t => {
  const { store, cache, checkpoint } = setup(t);
  const value = checkpoint(1); value.circular = value;
  store.transaction(() => {
    store.event('invented-committed-controller-work', {});
    assert.equal(cache.save(value), false);
  });
  await cache.flush();
  assert.equal(cache.status().status, 'failed');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='invented-committed-controller-work'").get().n, 1);
});

test('worker failure drops its queued cache snapshots, joins termination and permits a later retry', async t => {
  const { store, cache, checkpoint } = setup(t);
  const first = checkpoint(1); cache.save(first); await cache.flush();
  const second = checkpoint(2), latest = checkpoint(3), before = store.checkpoint();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    cache.save(second); cache.save(latest);
    assert.equal(cache.status().active, true);
    assert.equal(cache.status().pending, true);
    cache.worker.emit('error', new Error('invented-private-worker-detail'));
    await cache.flush();
  } finally { store.db.exec('ROLLBACK'); }
  assert.equal(cache.worker, null);
  assert.equal(cache.status().status, 'failed');
  assert(!JSON.stringify(cache.status()).includes('invented-private-worker-detail'));
  assert.deepEqual(store.getState('adaptive:mqtt'), first);
  assert.deepEqual(store.checkpoint(), before);
  cache.save(latest); await cache.flush();
  assert.deepEqual(store.getState('adaptive:mqtt'), latest);
  assert.equal(cache.status().error, null);
});

test('write permission and joined shutdown prevent pending cache writes after teardown', async t => {
  let allowed = false;
  const { store, cache, checkpoint } = setup(t, { canWrite: () => allowed });
  const first = checkpoint(1);
  assert.equal(cache.save(first), false);
  allowed = true; cache.save(first); allowed = false;
  await cache.flush();
  assert.equal(store.getState('adaptive:mqtt'), null);
  allowed = true; cache.save(first); await cache.flush();
  const latest = checkpoint(2), before = store.checkpoint();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    cache.save(latest);
    assert.equal(cache.status().active, true);
    cache.beginShutdown();
    await cache.close();
  } finally { store.db.exec('ROLLBACK'); }
  assert.equal(cache.worker, null);
  assert.equal(cache.status().active, false);
  assert.equal(cache.status().pending, false);
  assert.equal(cache.save(latest), false);
  assert.deepEqual(store.getState('adaptive:mqtt'), first);
  assert.deepEqual(store.checkpoint(), before);
});
