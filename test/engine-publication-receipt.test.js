import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { publishLearning } from '../src/app/learning-publication.js';
import { replayLearningJournal, LEARNING_WINDOW_MS as WINDOW } from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

const START = Date.parse('2026-10-07T12:00:00Z');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const selection of ['corrected', 'empty'])
test(`a delayed heating receipt learns from the published ${selection} history`, async t => {
  const store = new Store(':memory:');
  let now = START;
  const engine = new Engine({ store, config: { input: 'mqtt', settings: {} }, clock: () => now });
  t.after(async () => {
    engine.beginShutdown({ restore: false });
    await engine.charging.close(); await engine.garage.close({ restore: false });
    await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close();
  });
  const load = addFireplace(store, 'mqtt', { requestId: 'synthetic-load', kg: 4 }, START - 10 * WINDOW);
  for (let index = 8; index >= 1; index--) appendLearningRecord(store, 'mqtt', 'sample', {
    timestamp: START - index * WINDOW, indoorC: 21, outdoorC: 0, solarRadiationWm2: 0,
    phase: 'normal', roomBoostC: 0, targetC: 21, regime: 'occupied', quality: [],
  }, { config: engine.control });
  engine.checkpoint = replayLearningJournal(store, 'mqtt');
  const command = deferred();
  engine.automationEnabled = () => true;
  engine.executor.execute = () => command.promise;
  await store.runWrite(() => engine.tick());
  const previous = engine.checkpoint;
  if (selection === 'corrected') {
    removeFireplace(store, 'mqtt', { requestId: 'synthetic-removal', id: load.id }, now);
    const corrected = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
    await publishLearning({ store, input: 'mqtt', kind: 'correction', message: {
      epoch: store.learningEpoch('mqtt'), selection: store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation,
      revision: corrected.fireplaceRevision, sensorRevision: corrected.sensorRevision,
      head: store.learningJournalHead('mqtt'), checkpoint: corrected,
    }, onPublish: result => { engine.checkpoint = result.checkpoint; } });
    assert.notEqual(engine.checkpoint.fireplaceRevision, previous.fireplaceRevision);
  } else {
    // Complete source exclusion selects a new empty epoch and publishes no
    // checkpoint. Earlier journal inputs remain retained in their original epoch.
    await store.runPublication(async () => {
      store.transaction(() => {
        store.db.prepare("INSERT INTO learning_epochs(input,epoch) VALUES('mqtt','empty-corrected-epoch')").run();
        store.setState('adaptive:mqtt', null);
      });
      engine.checkpoint = null;
    });
  }
  const publishedHead = store.learningJournalHead('mqtt'), replayed = [];
  const journal = store.learningJournal.bind(store);
  t.mock.method(store, 'learningJournal', options => {
    const rows = journal(options);
    if (options.limit === 256) replayed.push(...rows.map(row => row.id));
    return rows;
  });
  now += 1000;
  command.resolve({ status: 'mqtt', sent: true, phase: 'normal', expiresAt: START + 60_000 });
  await engine.dispatchPending;
  assert.equal(store.getState('applied:mqtt').at, now, 'receipt retains the actual completion time');
  assert(replayed.every(id => id > publishedHead), 'receipt must not synchronously rebuild already published learning');
  if (selection === 'empty') {
    const first = journal({ input: 'mqtt', limit: 1 })[0];
    assert(first, 'the received control outcome starts current-context evidence');
    assert.equal(first.payload.seed, null, 'excluded learning cannot seed the new empty interpretation');
  }
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});

test('application close aborts accepted history work before awaiting teardown', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-history-shutdown-fence-'));
  const entered = deferred();
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const app = await start({ config, clock: () => START, installSignalHandlers: false,
    historyRecoveryOptions: { recoveryModule: async () => ({ recoveryPreview({ signal }) {
      entered.resolve(signal);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } }) } });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const pending = app.historyRecovery.checkPath({ donorPath: join(directory, 'synthetic-donor.sqlite'),
    source: { id: 'synthetic-source', kind: 'backup', label: 'Saved backup · 2026-10-07T12:00:00.000Z' } });
  const signal = await entered.promise;
  const closing = app.close();
  assert.equal(signal.aborted, true, 'the accepted recovery must be fenced synchronously with shutdown');
  await assert.rejects(pending);
  await closing;
});
