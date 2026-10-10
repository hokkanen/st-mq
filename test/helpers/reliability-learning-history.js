import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';
import { Store } from '../../src/storage/store.js';
import { recordLearningContext, replayLearningJournal, LEARNING_WINDOW_MS } from '../../src/app/committed-learning.js';
import { addSensorChange, revertSensorChange } from '../../src/app/sensor-changes.js';
import { addFireplace, removeFireplace } from '../../src/app/fireplace.js';
import { recoveryPreview, recoverHistory, previewRecoveryRevision, reviseRecovery, listRecoveries } from '../../src/recovery/service.js';
import { selectedHistory } from '../../src/recovery/ledger.js';
import { appendLearningRecord } from './home-learning-fixture.js';

export const start = Date.parse('2026-01-01T00:00:00Z'), W = LEARNING_WINDOW_MS;
const input = 'mqtt';
const initialConfig = { heatPumpCompressorKw: 3, auxRatedKw: 9, circulationKw: 0.08, dhwrKw: 0.025 };

export function generatedHistory(seed, windows) {
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
  return Array.from({ length: windows }, (_, index) => {
    const n = index + 1, gap = n % 17 === 0;
    return { n, at: start + n * W, indoorC: gap ? null : 20.8 + Math.round(random() * 80) / 100,
      outdoorC: Math.round((random() * 12 - 5) * 10) / 10,
      solarRadiationWm2: Math.round(random() * 240), gap,
      config: n <= windows / 2 ? initialConfig : { ...initialConfig, heatPumpCompressorKw: 3.1 } };
  });
}

export function appendGeneratedSample(store, row) {
  const observationId = store.observation({ source: 'synthetic', device: 'invented-room', signal: 'indoor_temperature',
    unit: 'degC', value: row.indoorC, sourceTime: row.at, receivedAt: row.at, quality: row.gap ? ['missing'] : [] });
  appendLearningRecord(store, input, 'sample', { timestamp: row.at, windowStart: row.at - W, windowEnd: row.at,
    indoorC: row.indoorC, outdoorC: row.outdoorC, solarRadiationWm2: row.solarRadiationWm2,
    phase: 'normal', roomBoostC: 0, targetC: 21, regime: 'occupied',
    quality: row.gap ? ['missing_indoor_temperature'] : [], energyBasis: 'estimated', actualModeKnown: false,
    provenance: { basis: 'committed-history', observationId } }, { config: row.config });
}

function appendPeriod(store, trace, from, through, corrections) {
  let change, load, checkpoint = store.getState(`adaptive:${input}`);
  for (const row of trace.slice(from - 1, through)) {
    const local = row.n - from + 1;
    if (corrections && local === 3) load = addFireplace(store, input,
      { requestId: `synthetic-load-${from}`, kg: 2 + row.n % 4 }, row.at - 100);
    if (corrections && local === 5) change = addSensorChange(store, input,
      { requestId: `synthetic-sensor-${from}`, signal: 'indoor_temperature', reason: 'replacement' }, row.at - 100,
      { config: row.config });
    if (corrections && local === 10) removeFireplace(store, input,
      { requestId: `synthetic-remove-${from}`, id: load.id }, row.at - 100);
    if (corrections && local === 12) revertSensorChange(store, input,
      { requestId: `synthetic-revert-${from}`, id: change.id }, row.at - 100, { config: row.config });
    appendGeneratedSample(store, row);
    checkpoint = replayLearningJournal(store, input, checkpoint);
  }
  assert.deepEqual(replayLearningJournal(store, input, null, { rebuild: true, persistCheckpoint: false }), checkpoint);
}

export async function prepareGeneratedHistory({ masterPath, donorPath, donorSnapshot, trace }) {
  const master = new Store(masterPath);
  let donor;
  try {
    recordLearningContext(master, input, { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start,
      { config: initialConfig });
    const prefix = 16, through = Math.floor(trace.length * 2 / 3);
    appendPeriod(master, trace, 1, prefix, true);
    const permission = { version: 3, features: { home: { enabled: false, identity: 'a'.repeat(64), targetIdentity: null,
      pause: { id: 'synthetic-current-pause', createdAt: start, expiresAt: null }, revision: 1 } } };
    const restoration = { version: 2, targetBindings: { dhwr: { identity: 'b'.repeat(64), generation: 'synthetic-current-circulation' } },
      phase: 'normal', legacyOutstanding: false, dhwrOutstanding: true, pulseUntil: start + 100 * W, expiresAt: null };
    master.setState('automation:mqtt', permission);
    master.setState('executor:home', restoration);
    await master.backup(donorPath);
    donor = new Store(donorPath);
    // Genuine application-owned keys deliberately disagree on the donor. History
    // recovery must neither acquire its permission nor erase the local OFF duty.
    donor.setState('automation:mqtt', { version: 3, features: { home: { ...permission.features.home,
      enabled: true, identity: 'c'.repeat(64), targetIdentity: 'd'.repeat(64), pause: null } } });
    donor.setState('executor:home', { ...restoration, dhwrOutstanding: false, pulseUntil: 0,
      targetBindings: { dhwr: { identity: 'e'.repeat(64), generation: 'synthetic-donor-circulation' } } });
    appendPeriod(donor, trace, prefix + 1, through, true);
    appendPeriod(master, trace, through + 1, trace.length, false);
    await donor.backup(donorSnapshot);
  } finally { donor?.close(); master.close(); }
}

export function selectedState(store) {
  return { epoch: store.learningEpoch(input), selection: selectedHistory(store),
    checkpoint: store.getState(`adaptive:${input}`), authority: store.db.prepare(
      "SELECT key,value,updated_at FROM state WHERE key IN ('automation:mqtt','executor:home') ORDER BY key").all() };
}

export function originalEvidence(store) {
  return {
    journal: store.db.prepare('SELECT * FROM learning_journal_entries WHERE source_entry_id IS NULL ORDER BY id').all(),
    observations: store.db.prepare('SELECT * FROM observations ORDER BY id').all(),
    fireplace: store.db.prepare('SELECT * FROM fireplace_events ORDER BY id').all(),
  };
}

export function assertOriginalEvidence(store, original) {
  for (const [name, rows] of Object.entries(original)) {
    const table = { journal: 'learning_journal_entries', observations: 'observations', fireplace: 'fireplace_events' }[name];
    const query = store.db.prepare(`SELECT * FROM ${table} WHERE id=?`);
    for (const row of rows) assert.deepEqual(query.get(row.id), row, `${name} source ${row.id} changed`);
  }
}

export async function runRecoveryOperation(store, donorPath, action, options = {}) {
  if (action === 'recover') {
    const preview = await recoveryPreview({ masterPath: store.path, donorPath, input, signal: options.signal });
    return recoverHistory({ store, donorPath, input, preview, ...options });
  }
  const recoveryId = listRecoveries(store, input)[0]?.id;
  assert(recoveryId, 'the selected operation has a retained recovery');
  const args = { store, input, recoveryId, active: action === 'restore', ...options };
  return reviseRecovery({ ...args, preview: await previewRecoveryRevision(args) });
}

async function childMain() {
  const [path, donorPath, action, boundary] = process.argv.slice(3), store = new Store(path);
  const kill = point => {
    writeFileSync(`${path}.crash.json`, JSON.stringify({ action, boundary, point, threadId, inTransaction: store.db.isTransaction }));
    process.kill(process.pid, 'SIGKILL');
  };
  await runRecoveryOperation(store, donorPath, action, {
    onProgress(value) {
      if (boundary === 'before-publication' && value.phase === 'rebuilding' && value.processed > 0)
        kill('worker-rebuilt-batch');
    },
    onPublish() {
      if (boundary === 'after-commit') {
        assert.equal(store.db.isTransaction, false);
        kill('published-before-acknowledgement');
      }
    },
  });
  store.close();
  throw new Error('The requested crash boundary was not reached');
}

if (process.argv[2] === '--crash-child' && import.meta.url === pathToFileURL(process.argv[1]).href) await childMain();
