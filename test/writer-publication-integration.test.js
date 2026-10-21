import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { verifyJournal } from '../src/storage/journal.js';
import { publishLearning, publicationKey } from '../src/app/learning-publication.js';
import { peerOperation, PeerTransfers } from '../src/replication/coalesced.js';
import { recoverHistory, recoveryPreview, previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { applyLearningRecord, replayLearningJournal } from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { createMqttSourceContext, mqttSourceIdentity, MQTT_SOURCE_CONTEXT_KEY } from '../src/pairing/mqtt-source-context.js';
import { randomUUID } from 'node:crypto';
import { coefficientCandidate } from './helpers/coefficient-fixture.js';
import { createCoefficientGeneration, readCoefficientCoverage, readCoefficientEvents } from '../src/storage/coefficient-history.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-writer-publication-'));
  const store = new Store(join(directory, 'current.sqlite'));
  const stores = [store];
  t.after(async () => {
    for (const value of stores) await value.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.startWriter();
  return { directory, store, stores };
}

function holdCommit(store) {
  const request = store.writer.request.bind(store.writer);
  let entered, release, held = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  store.writer.request = async (operation, ...args) => {
    if (operation === 'commit' && !held) { held = true; entered(); await gate; }
    return request(operation, ...args);
  };
  return { ready, release };
}

async function correction(store) {
  return store.runWrite(() => {
    store.setState('fireplace:rebuild:mqtt', { status: 'pending' });
    return { epoch: store.learningEpoch('mqtt'), selection: 'original', revision: 0,
      sensorRevision: 0, head: 0, checkpoint:null, coefficientGeneration:createCoefficientGeneration(store,'mqtt') };
  });
}

function publicationWorker(options) {
  return new Worker(new URL('../src/app/learning-publication-worker.js', import.meta.url), options);
}

test('backup during a pending writer commit contains only one complete committed boundary', { timeout: 20_000 }, async t => {
  const { directory, store, stores } = await fixture(t);
  await store.runWrite(() => store.setState('value', 'previous'));
  const before = store.checkpoint(), gate = holdCommit(store);
  const pending = store.runWrite(() => store.setState('value', 'replacement'));
  await gate.ready;
  try {
    const path = await store.backup(join(directory, 'before.sqlite'), { signal: t.signal });
    const snapshot = new Store(path, { readOnly: true }); stores.push(snapshot);
    assert.equal(snapshot.getState('value'), 'previous');
    assert.deepEqual(snapshot.checkpoint(), before);
    assert.equal(snapshot.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    verifyJournal(snapshot.db);
  } finally { gate.release(); }
  await pending;
  const path = await store.backup(join(directory, 'after.sqlite'), { signal: t.signal });
  const snapshot = new Store(path, { readOnly: true }); stores.push(snapshot);
  assert.equal(snapshot.getState('value'), 'replacement');
  assert.deepEqual(snapshot.checkpoint(), store.checkpoint());
  verifyJournal(snapshot.db); verifyJournal(store.db);
});

test('peer export and acknowledgement retain changes made by the dedicated runtime writer', { timeout: 20_000 }, async t => {
  const { directory, store, stores } = await fixture(t);
  await peerOperation('enroll', { dbPath: store.path, signal: t.signal });
  const base = store.checkpoint(), replicaPath = join(directory, 'replica.sqlite');
  await store.backup(replicaPath, { signal: t.signal });
  await store.runWrite(() => { store.setState('shared', 1); store.event('synthetic-receipt', {}, 123); });
  const frozen = store.checkpoint(), transfers = new PeerTransfers(join(directory, 'transfers'));
  const transfer = await transfers.export({ dbPath: store.path, after: base, signal: t.signal,
    onYield: () => store.runWrite(() => {}) });
  assert.deepEqual(transfer.target, frozen);
  assert.ok(transfer.sourceStartedAt <= transfer.sourceAt);
  await store.runWrite(() => store.setState('shared', 2));
  const target = await peerOperation('apply', { dbPath: replicaPath,
    path: join(directory, 'transfers', `peer-${transfer.id}.changes`), metadata: transfer, signal: t.signal });
  assert.deepEqual(target, frozen);
  const replica = new Store(replicaPath, { readOnly: true }); stores.push(replica);
  assert.equal(replica.getState('shared'), 1);
  assert.equal(replica.events({ type: 'synthetic-receipt' })[0].at, 123);
  const acknowledged = await peerOperation('acknowledge', { dbPath: store.path, checkpoint: target,
    signal: t.signal, onYield: () => store.runWrite(() => {}) });
  assert.equal(acknowledged.complete, true);
  const next = await transfers.export({ dbPath: store.path, after: target, signal: t.signal });
  assert.deepEqual(next.target, store.checkpoint());
  assert.equal(next.rows, 1, 'the later same-key change survives rebasing an earlier frozen transfer');
  verifyJournal(replica.db); verifyJournal(store.db);
});

test('paired MQTT context waits for admitted durability and retains source identity through verified handover', { timeout: 20_000 }, async t => {
  const { directory, store } = await fixture(t), gate = holdCommit(store);
  const first = { topology: 'pair', input: 'mqtt', pair: { pairId: 'synthetic-pair',
    token: 'synthetic-pair-token-only', vip: { address: '192.0.2.30' } },
    connections: { mqtt: { address: 'mqtt://first-synthetic-broker', user: 'synthetic-user' } } };
  const second = { ...first, connections: { mqtt: { address: 'mqtt://second-synthetic-broker', user: 'synthetic-local-user' } } };
  const local = createMqttSourceContext({ configuration: () => first, directory: join(directory, 'first-context') });
  const remote = createMqttSourceContext({ configuration: () => second, directory: join(directory, 'second-context') });
  const pending = store.runWrite(() => store.setState('before-source-seed', true));
  await gate.ready;
  let activated = false;
  const activating = local.activate(first, store, { allowSeed: true }).then(() => { activated = true; });
  await delay(25);
  assert.equal(activated, false);
  assert.equal(store.getState(MQTT_SOURCE_CONTEXT_KEY), null);
  gate.release(); await pending; await activating;
  assert.equal(activated, true);
  const requirements = local.requirements(store), args = { requirements, token: randomUUID(), dbPath: store.path };
  await remote.prepare(args); remote.verify(args); await remote.authorize(args); await remote.activate(second, store);
  assert.deepEqual(mqttSourceIdentity(second), mqttSourceIdentity(first));
  assert.equal(second.connections.mqtt.address, 'mqtt://second-synthetic-broker');
  assert.equal(store.getState('before-source-seed'), true);
  verifyJournal(store.db);
});

test('failed paired MQTT seed durability remains unbound and can retry the same initialization', { timeout: 20_000 }, async t => {
  const { directory, store } = await fixture(t);
  const config = { topology: 'pair', input: 'mqtt', pair: { pairId: 'synthetic-failed-seed',
    token: 'synthetic-pair-token-only', vip: { address: '192.0.2.30' } },
    connections: { mqtt: { address: 'mqtt://synthetic-broker', user: 'synthetic-user' } } };
  const options = { configuration: () => config, directory: join(directory, 'failed-context') };
  const request = store.writer.request.bind(store.writer);
  let failed = false;
  store.writer.request = async (operation, ...args) => {
    if (operation === 'commit' && !failed) {
      failed = true;
      throw Object.assign(new Error('synthetic storage failure'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    }
    return request(operation, ...args);
  };
  await assert.rejects(createMqttSourceContext(options).activate(config, store, { allowSeed: true }));
  assert.equal(failed, true);
  assert.equal(store.getState(MQTT_SOURCE_CONTEXT_KEY), null);
  const restarted = createMqttSourceContext(options);
  await restarted.activate(config, store, { allowSeed: true });
  assert.ok(store.getState(MQTT_SOURCE_CONTEXT_KEY));
  assert.ok(restarted.requirements(store));
  verifyJournal(store.db);
});

test('correction publication waits for active durability and adopts before the next admitted write', { timeout: 20_000 }, async t => {
  const { store } = await fixture(t), message = await correction(store), gate = holdCommit(store), order = [];
  const pending = store.runWrite(() => { store.setState('before-publication', true); store.afterCommit(() => order.push('saved')); });
  await gate.ready;
  const publishing = publishLearning({ store, input: 'mqtt', kind: 'correction', message,
    onPublish(result) {
      order.push('adopted');
      assert.equal(result.epoch, message.epoch);
      assert.equal(store.getState('fireplace:rebuild:mqtt').status, 'current');
      assert.equal(readCoefficientCoverage(store,{input:'mqtt'}).generation,message.coefficientGeneration);
      assert.ok(store.getState(publicationKey('mqtt')).token);
    } });
  const later = store.runWrite(() => {
    order.push('later');
    assert.equal(store.getState('fireplace:rebuild:mqtt').status, 'current');
    store.setState('after-publication', true);
  });
  await delay(25);
  assert.deepEqual(order, []);
  gate.release(); await pending; await publishing; await later;
  assert.deepEqual(order, ['saved', 'adopted', 'later']);
  verifyJournal(store.db);
});

test('a correction without complete staged coefficient history cannot publish a model or durable receipt', { timeout:20_000 }, async t => {
  const {store}=await fixture(t), message=await correction(store);
  delete message.coefficientGeneration;
  const checkpoint=store.getState('adaptive:mqtt'), coverage=readCoefficientCoverage(store,{input:'mqtt'});
  await assert.rejects(publishLearning({store,input:'mqtt',kind:'correction',message,
    onPublish:()=>assert.fail('incomplete correction adopted')}));
  assert.deepEqual(store.getState('adaptive:mqtt'),checkpoint);
  assert.deepEqual(readCoefficientCoverage(store,{input:'mqtt'}),coverage);
  assert.equal(store.getState('fireplace:rebuild:mqtt').status,'pending');
  assert.equal(store.getState(publicationKey('mqtt')),null);
  verifyJournal(store.db);
});

test('a correction cancelled behind active writer durability never starts publication', { timeout: 20_000 }, async t => {
  const { store } = await fixture(t), message = await correction(store), gate = holdCommit(store);
  const pending = store.runWrite(() => store.setState('before-cancel', true));
  await gate.ready;
  const cancellation = new AbortController();
  const cancelled = publishLearning({ store, input: 'mqtt', kind: 'correction', message,
    signal: cancellation.signal, workerFactory: () => assert.fail('cancelled publication started'),
    onPublish: () => assert.fail('cancelled publication adopted') }).catch(error => error);
  cancellation.abort(); gate.release(); await pending;
  assert.equal((await cancelled).code, 'STORAGE_WRITE_CANCELLED');
  assert.equal(store.getState('fireplace:rebuild:mqtt').status, 'pending');
  assert.equal(store.getState(publicationKey('mqtt')), null);
  await store.runWrite(() => store.setState('after-cancel', true));
  verifyJournal(store.db);
});

for (const boundary of ['lost-reply', 'cancel-after-commit']) test(`correction ${boundary} adopts its durable receipt once before queued writes`,
  { timeout: 20_000 }, async t => {
    const { store } = await fixture(t), message = await correction(store), cancellation = new AbortController();
    let adopted = 0, intercepted = false;
    const publishing = publishLearning({ store, input: 'mqtt', kind: 'correction', message,
      signal: cancellation.signal, workerFactory(options) {
        const worker = publicationWorker(options), emit = worker.emit;
        worker.emit = function (event, value, ...rest) {
          if (event === 'message' && value?.type === 'result' && !intercepted) {
            intercepted = true;
            if (boundary === 'lost-reply') return false;
            cancellation.abort();
          }
          return emit.call(this, event, value, ...rest);
        };
        return worker;
      }, onPublish() { adopted++; } });
    const later = store.runWrite(() => {
      assert.equal(adopted, 1);
      assert.equal(store.getState('fireplace:rebuild:mqtt').status, 'current');
      assert.equal(readCoefficientCoverage(store,{input:'mqtt'}).generation,message.coefficientGeneration);
      store.setState('after-reconciled-publication', true);
    });
    const result = await publishing; await later;
    assert.equal(intercepted, true); assert.equal(adopted, 1);
    assert.equal(result.epoch, message.epoch);
    assert.equal(store.getState('after-reconciled-publication'), true);
    verifyJournal(store.db);
  });

test('revoked authority at specialized worker admission preserves the previous selected model', { timeout: 20_000 }, async t => {
  const { store } = await fixture(t), message = await correction(store);
  let current = true, reached = false;
  await assert.rejects(publishLearning({ store, input: 'mqtt', kind: 'correction', message,
    isCurrent: () => current, workerFactory(options) {
      const worker = publicationWorker(options);
      worker.on('message', value => { if (value?.type === 'ready') { current = false; reached = true; } });
      return worker;
    }, onPublish: () => assert.fail('revoked publication adopted') }));
  assert.equal(reached, true);
  assert.equal(store.getState('fireplace:rebuild:mqtt').status, 'pending');
  assert.equal(store.getState(publicationKey('mqtt')), null);
  await store.runWrite(() => store.setState('after-revocation', true));
  verifyJournal(store.db);
});

test('a nonempty corrected model and shared sample bodies publish atomically and reconstruct exactly', { timeout: 20_000 }, async t => {
  const { store } = await fixture(t), at = Date.parse('2026-01-01T00:00:00Z');
  let load, previous;
  await store.runWrite(() => {
    load = addFireplace(store, 'mqtt', { requestId: 'synthetic-firewood-load', kg: 4 }, at);
    for (let i = 1; i <= 8; i++) {
      const timestamp = at + i * 900_000;
      appendLearningRecord(store, 'mqtt', 'sample', { timestamp, windowStart: timestamp - 900_000, windowEnd: timestamp,
        indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, quality: [], phase: 'normal', regime: 'occupied',
        targetC: 21, roomBoostC: 0, actualModeKnown: false, powerKw: 3, energyBasis: 'estimated' });
    }
    previous = replayLearningJournal(store, 'mqtt');
    removeFireplace(store, 'mqtt', { requestId: 'synthetic-firewood-removal', id: load.id }, at + 8 * 900_000 + 1);
  });
  const journal = store.learningJournal({ input: 'mqtt' }), context = fireplaceLearningContext(store, 'mqtt');
  const expected = journal.reduce((checkpoint, entry) => applyLearningRecord(checkpoint, entry, context), null);
  assert.notDeepEqual(expected, previous);
  assert.deepEqual(store.getState('adaptive:mqtt'), previous, 'the old model remains selected before publication');
  const original=readCoefficientCoverage(store,{input:'mqtt'});
  const candidate=await store.runWrite(()=>coefficientCandidate(store,'mqtt'));
  assert.deepEqual(candidate.checkpoint,expected);
  assert.deepEqual(readCoefficientCoverage(store,{input:'mqtt'}),original,'staged history leaves the earlier selected model interpretation intact');
  const stagedEvents=readCoefficientEvents(store,{input:'mqtt',generation:candidate.coefficientGeneration});
  assert(stagedEvents.length>0);
  const message = { epoch: store.learningEpoch('mqtt'), selection: 'original', revision: context.fireplaceRevision,
    sensorRevision: 0, head: store.learningJournalHead('mqtt'), ...candidate };
  let adopted = 0;
  const result = await publishLearning({ store, input: 'mqtt', kind: 'correction', message,
    onPublish(value) {
      adopted++; assert.deepEqual(value.checkpoint, expected);
      assert.equal(readCoefficientCoverage(store,{input:'mqtt'}).generation,candidate.coefficientGeneration);
      assert.deepEqual(readCoefficientEvents(store,{input:'mqtt'}),stagedEvents,
        'durable receipt adoption sees the whole corrected model and all coefficient transitions together');
    } });
  assert.equal(adopted, 1);
  assert.deepEqual(result.checkpoint, expected);
  assert.deepEqual(store.getState('adaptive:mqtt'), expected);
  assert.deepEqual(store.learningJournal({ input: 'mqtt' }), journal, 'publication never rewrites committed source inputs');
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), expected);
  assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM learning_checkpoint_samples').get().n > 0);
  verifyJournal(store.db);
});

test('shutdown terminates an uncommitted specialized publication before closing writer storage', { timeout: 20_000 }, async t => {
  const { store, stores } = await fixture(t), message = await correction(store);
  let entered, adopted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const publishing = publishLearning({ store, input: 'mqtt', kind: 'correction', message,
    workerFactory(options) {
      const worker = publicationWorker(options), post = worker.postMessage;
      worker.postMessage = function (value, ...rest) {
        if (value?.type === 'publish') { entered(); return; }
        return post.call(this, value, ...rest);
      };
      return worker;
    }, onPublish() { adopted = true; } }).catch(error => error);
  await ready;
  const queued = store.runWrite(() => assert.fail('shutdown ran queued work')).catch(error => error);
  await store.close();
  assert.ok(await publishing instanceof Error);
  assert.equal((await queued).code, 'STORAGE_CLOSED');
  assert.equal(adopted, false);
  const reopened = new Store(store.path, { readOnly: true }); stores.push(reopened);
  assert.equal(reopened.getState('fireplace:rebuild:mqtt').status, 'pending');
  assert.equal(reopened.getState(publicationKey('mqtt')), null);
  verifyJournal(reopened.db);
});

test('history recovery shares publication admission with the dedicated writer and preserves controller state', { timeout: 30_000 }, async t => {
  const { directory, store, stores } = await fixture(t);
  await store.runWrite(() => store.setState('controller:sentinel', { permission: 'paused', identity: 'invented-equipment' }));
  const donorPath = join(directory, 'donor.sqlite');
  await store.backup(donorPath, { signal: t.signal });
  const donor = new Store(donorPath); stores.push(donor);
  donor.observation({ source: 'synthetic', device: 'invented-meter', signal: 'indoor_temperature', value: 21,
    unit: 'degC', sourceTime: 123, receivedAt: 456, quality: [] });
  const donorSnapshot = join(directory, 'donor-snapshot.sqlite');
  await donor.backup(donorSnapshot, { signal: t.signal });
  const preview = await recoveryPreview({ masterPath: store.path, donorPath: donorSnapshot, signal: t.signal });
  let adopted = 0, live = false;
  const result = await recoverHistory({ store, donorPath: donorSnapshot, preview, signal: t.signal,
    async onProgress(progress) {
      if (progress.phase === 'importing' && !live) {
        live = true;
        await store.runWrite(() => store.event('synthetic-live-during-recovery', {}, 789));
      }
    }, onPublish() { adopted++; } });
  assert.equal(adopted, 1);
  assert.ok(result.report.imported >= 1);
  assert.equal(store.observations().find(row => row.device === 'invented-meter').receivedAt, 456);
  assert.deepEqual(store.getState('controller:sentinel'), { permission: 'paused', identity: 'invented-equipment' });
  assert.equal(store.learningEpoch('mqtt'), result.epoch);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  verifyJournal(store.db);
});

test('restoration publishes once when an earlier admitted commit extends already checked evidence', { timeout: 30_000 }, async t => {
  const { directory, store, stores } = await fixture(t), donorPath = join(directory, 'queued-proof-donor.sqlite');
  await store.backup(donorPath, { signal: t.signal });
  const donor = new Store(donorPath); stores.push(donor);
  const observation = (target, at, device) => target.observation({ source: 'synthetic', device,
    signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: at, receivedAt: at, quality: [] });
  observation(donor, 100, 'invented-recovered-sensor');
  const snapshot = join(directory, 'queued-proof-donor-snapshot.sqlite');
  await donor.backup(snapshot, { signal: t.signal });
  const preview = await recoveryPreview({ masterPath: store.path, donorPath: snapshot, signal: t.signal });
  const accepted = await recoverHistory({ store, donorPath: snapshot, preview, signal: t.signal });
  const args = { store, input: 'mqtt', recoveryId: accepted.report.recoveryId, signal: t.signal };
  const revert = { ...args, active: false };
  await reviseRecovery({ ...revert, preview: await previewRecoveryRevision(revert) });
  const key = 'recorder:energy:["synthetic","synthetic-queued-proof-meter","property"]';
  const tail = end => ({ lastEnd: end, lastReceivedAt: end,
    pending: { start: 50, end, receivedAt: end, energies: [0.1, 0.2, 0.3], quality: [] },
    lastPowers: [1, 2, 3], lastQuality: [], scales: [null, null, null] });
  await store.runWrite(() => store.setState(key, tail(200)));
  const restore = { ...args, active: true }, checked = await previewRecoveryRevision(restore);
  const publish = store.runPublication.bind(store);
  let attempts = 0;
  store.runPublication = (operation, options) => {
    attempts++;
    if (attempts !== 1) return publish(operation, options);
    // This write is accepted after the worker prepared its proof, before the
    // publication queues. Its commit must remain ahead of publication and make
    // that exact evidence version stale, without relying on timer coincidence.
    const gate = holdCommit(store);
    const changing = store.runWrite(() => {
      observation(store, 300, 'invented-later-sensor');
      store.setState(key, tail(300));
    });
    const publishing = publish(operation, options);
    return (async () => {
      try { await gate.ready; } finally { gate.release(); }
      await changing;
      return publishing;
    })();
  };
  await reviseRecovery({ ...restore, preview: checked });
  assert.equal(attempts, 1, 'a harmless admitted suffix is verified under the final lock without restarting reconstruction');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n, 2);
  assert.equal(store.getState(key).pending.end, 300);
  verifyJournal(store.db);
});
