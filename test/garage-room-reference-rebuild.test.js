import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { garageSettings } from '../src/garage/settings.js';
import { appendGarageEntry, applyGarageEntry, garageInput, garageJournalHead, replayGarageJournal } from '../src/garage/learning.js';

const START = Date.parse('2026-01-01T00:00:00Z');
function fixture(t, { laterTarget = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-room-reference-rebuild-'));
  const store = new Store(join(directory, 'history.sqlite')), settings = garageSettings();
  const first = appendGarageEntry(store, 'mqtt', 'context', { roomTargetC: 20 }, settings, START, { key: 'initial-room-setting' });
  store.setState('garage:checkpoint:mqtt', applyGarageEntry(null, first));
  store.setState('garage:configuration:mqtt', settings);
  if (laterTarget !== null) appendGarageEntry(store, 'mqtt', 'context', { roomTargetC: laterTarget }, settings,
    START + 1000, { key: 'later-physical-room-setting' });
  let now = START + 2000;
  const runtime = new GarageRuntime({ store, engine: { latest: {}, settings: { mode: 'shadow' } },
    config: { input: 'mqtt', garage: settings }, clock: () => now });
  const state = { connected: false, health: { pumpCommunicating: false }, native: {},
    limits: { restorationDelayMs: 120_000 } };
  runtime.setAdapter({ status: () => state, safetyTick: async () => {} });
  t.after(async () => {
    await runtime.close({ restore: false }); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, runtime, state, advance() { now += 1000; return now; } };
}
async function completed(runtime) {
  const deadline = Date.now() + 5000;
  while (runtime.learningStatus === 'rebuilding' && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.learningStatus, 'current');
}

test('async restart uses the newest journaled room target ahead of the checkpoint', async t => {
  const f = fixture(t, { laterTarget: 22 });
  assert.equal(f.runtime.learningStatus, 'rebuilding');
  assert.equal(f.runtime.checkpoint.model.normalReference.roomTargetC, 20);
  assert.equal(f.runtime.selectedRoomTargetC, 22);
  assert.equal(f.runtime.read().roomTargetC, 22);
  const head = garageJournalHead(f.store, 'mqtt');
  for (let i = 0; i < 100; i++) f.runtime.safetyTick();
  assert.equal(garageJournalHead(f.store, 'mqtt'), head, 'Safety polls cannot duplicate a committed room change');
  await completed(f.runtime);
  assert.equal(f.runtime.checkpoint.model.normalReference.roomTargetC, 22);
  assert.deepEqual(f.runtime.checkpoint, replayGarageJournal(f.store, 'mqtt'));
});

test('a fresh room change during async rebuild is journaled once and survives temporary loss of native reports', async t => {
  const f = fixture(t); f.runtime.startRebuild();
  const at = f.advance(), head = garageJournalHead(f.store, 'mqtt');
  Object.assign(f.state, { connected: true, health: { pumpCommunicating: true },
    native: { targetC: 22, readbacks: { targetC: { measuredAt: at, usable: true, available: true } } } });
  for (let i = 0; i < 100; i++) f.runtime.safetyTick();
  assert.equal(f.runtime.learningStatus, 'rebuilding');
  assert.equal(f.runtime.checkpoint.model.normalReference.roomTargetC, 20);
  assert.equal(garageJournalHead(f.store, 'mqtt'), head + 1);
  f.state.connected = false;
  for (let i = 0; i < 100; i++) f.runtime.safetyTick();
  assert.equal(f.runtime.read().roomTargetC, 22);
  assert.equal(garageJournalHead(f.store, 'mqtt'), head + 1, 'Stale model cannot overwrite newer source context');
  await completed(f.runtime);
  assert.equal(f.runtime.checkpoint.model.normalReference.roomTargetC, 22);
  assert.deepEqual(f.runtime.checkpoint, replayGarageJournal(f.store, 'mqtt'));
});

test('outer room-setting transaction failure rolls back source tracking and retries correctly during async rebuild', async t => {
  const f = fixture(t); f.runtime.startRebuild();
  const before = structuredClone(f.runtime.checkpoint), head = garageJournalHead(f.store, 'mqtt');
  const originalEvent = f.store.event.bind(f.store);
  f.store.event = (type, ...args) => {
    if (type === 'garage-room-target-changed') throw new Error('synthetic outer transaction failure');
    return originalEvent(type, ...args);
  };
  assert.throws(() => f.runtime.saveRoomTarget(23, f.advance()), /synthetic outer transaction failure/);
  assert.equal(garageJournalHead(f.store, 'mqtt'), head);
  assert.deepEqual(f.runtime.checkpoint, before);
  assert.equal(f.runtime.read().roomTargetC, 20);
  assert.equal(f.store.getState(f.runtime.keys.roomTemperature), null);
  f.store.event = originalEvent;
  f.runtime.saveRoomTarget(23, f.advance());
  const selectedHead = garageJournalHead(f.store, 'mqtt');
  for (let i = 0; i < 100; i++) f.runtime.safetyTick();
  assert.equal(f.runtime.read().roomTargetC, 23);
  assert.equal(garageJournalHead(f.store, 'mqtt'), selectedHead);
  f.runtime.saveRoomTarget(23, f.advance());
  const selections = f.store.learningJournal({ input: garageInput('mqtt'), after: head });
  assert.deepEqual(selections.map(entry => entry.payload.value.normalReferenceReset), [true, false],
    'Reapplying the same choice during rebuilding must preserve its newly learned context');
  await completed(f.runtime);
  assert.equal(f.runtime.checkpoint.model.normalReference.roomTargetC, 23);
  assert.deepEqual(f.runtime.checkpoint, replayGarageJournal(f.store, 'mqtt'));
});
