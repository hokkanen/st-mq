import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Entirely synthetic, including the temporary real writer database. Run the
// same harness against two source roots; compare fingerprints before timings.
const sourceRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)));
const load = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const [{ Engine }, { Store }, { appendLearningRecord, replayLearningJournal }, { recordedChargingEnergy }] = await Promise.all([
  load('src/app/engine.js'), load('src/storage/store.js'), load('src/app/committed-learning.js'), load('src/charging/energy.js'),
]);
const START = Date.parse('2026-10-01T12:00:00Z'), WINDOW = 900_000, HOUR = 3_600_000;

function richSample(at) {
  const segmentCount = 30, durationHours = WINDOW / segmentCount / HOUR;
  const inputSegments = Array.from({ length: segmentCount }, (_, index) => ({
    start: at - WINDOW + index * WINDOW / segmentCount,
    end: at - WINDOW + (index + 1) * WINDOW / segmentCount,
    outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0, targetC: 21,
    regime: 'occupied', episodeId: null, supplyC: 35 + index / 10, brineC: 0,
    compressorHeatKw: 9.4, sourceRelativeUncertainty: 0.25,
    sourceEstimateBasis: 'manufacturer-two-point-estimate; not measured heat or electricity',
    sourceUncertaintyReasons: ['installed-model-not-confirmed'], sourcePumpsIncluded: true,
    floorOverrideMode: 'off', treatmentKey: 'normal', compressorDuty: 1,
    compressorPowerKw: 2.2, circulationKw: 0, dhwrKw: 0, auxKw: 0, powerKw: 2.2,
    thermalCompressorDuty: 1, thermalAuxKw: 0, auxRoute: 'space',
    dhwCompressorDuty: 0, dhwAuxKw: 0, auxiliaryStage: 'off',
    auxiliaryPowerBasis: 'observed-output-stage', integral: -100 + index, supplyShortfallC: 1,
    operatingMode: 1, quality: [], hydronicHeatKw: 9.4,
    compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true,
    actualModeKnown: true, energyBasis: 'estimated', configurationVersion: 'a'.repeat(64),
    durationHours, energyKwh: 2.2 * durationHours, hydronicHeatKwh: 9.4 * durationHours,
    compressorKwh: 2.2 * durationHours, spaceHeatingAuxKwh: 0, dhwAuxKwh: 0,
  }));
  return { sensorInputVersion: 1, timestamp: at, windowStart: at - WINDOW, windowEnd: at,
    indoorC: 21, outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied',
    roomBoostC: 0, targetC: 21, quality: [], actualModeKnown: true, energyBasis: 'estimated',
    thermalCompressorDuty: 1, thermalAuxKw: 0,
    heating: { verified: true, compressorActive: true, compressorDuty: 1, route: 'space-heating', quality: [] },
    indoorSensors: { indoor_temperature: { value: 21, weight: 1, observedAt: at,
      reportCoverageComplete: true, reportCoveredThrough: at,
      reportIntervals: [{ start: at - WINDOW, end: at, observedAt: at, endpoint: true }] } }, inputSegments };
}

const directory = mkdtempSync(join(tmpdir(), 'stmq-controller-reads-'));
const store = new Store(join(directory, 'synthetic.sqlite'));
const now = START + 48 * WINDOW;
const engine = new Engine({ store, config: { input: 'mqtt', settings: {} }, clock: () => now });
const measurements = [];
const measure = (name, operation, count = 48) => {
  for (let n = 0; n < 4; n++) operation(n);
  const cpu = process.cpuUsage(), start = performance.now();
  for (let n = 0; n < count; n++) operation(n);
  const used = process.cpuUsage(cpu);
  measurements.push({ name, count, wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 });
};
const measureAsync = async (name, operation, count = 24) => {
  for (let n = 0; n < 4; n++) await operation(n);
  const cpu = process.cpuUsage(), start = performance.now();
  for (let n = 0; n < count; n++) await operation(n);
  const used = process.cpuUsage(cpu);
  measurements.push({ name, count, wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 });
};
try {
  store.transaction(() => {
    for (let n = 0; n < 48; n++) appendLearningRecord(store, 'mqtt', 'sample', richSample(START + n * WINDOW), { config: engine.control });
  });
  await engine.refreshLearning();
  await engine.learningCheckpointCache?.flush();
  const checkpointDigest = engine.checkpoint.checkpointDigest;
  measure('unchanged checkpoint view', () => engine.readAdaptive(now));
  await measureAsync('unchanged checkpoint worker replay', () => engine.refreshLearning());
  const failure = new Error('Synthetic rollback');
  engine.automation.reconcileTargets = () => { throw failure; };
  await measureAsync('tick rollback ownership', () => assert.rejects(engine.update(), error => error === failure));
  assert.equal(engine.checkpoint.checkpointDigest, checkpointDigest);
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
  store.transaction(() => {
    for (let n = 0; n < 600; n++) for (const phase of [1, 2, 3]) store.observation({
      source: 'shelly-evse', device: 'synthetic-evse', signal: `ev2_energy_l${phase}`, unit: 'kWh',
      sourceTime: START + (n + 1) * 30_000, receivedAt: START + (n + 1) * 30_000,
      value: n % 7 / 1000, quality: [], raw: { intervalStart: START + n * 30_000, intervalEnd: START + (n + 1) * 30_000 },
    });
  });
  await store.startWriter();
  const query = { id: 'charger2', start: START, end: now };
  let energy;
  measure('unchanged energy view committed reader', () => { energy = engine.charging.readEnergy(query); });
  assert.deepEqual(energy, recordedChargingEnergy(store, query));
  await store.runWrite(() => measure('unchanged energy view writer turn', () => {
    energy = engine.charging.readEnergy(query);
  }));
  assert.deepEqual(energy, recordedChargingEnergy(store, query));
  const fingerprint = createHash('sha256').update(JSON.stringify({ checkpointDigest, energy })).digest('hex');
  console.log(JSON.stringify({ node: process.version, sourceRoot, checkpointBytes: Buffer.byteLength(JSON.stringify(engine.checkpoint)),
    syntheticEnergyRows: 1800, fingerprint, measurements }, null, 2));
} finally {
  engine.beginShutdown({ restore: false });
  await engine.charging.close(); await engine.garage.close({ restore: false });
  await engine.closeFireplace(); await engine.executor.close({ restore: false });
  await store.close(); rmSync(directory, { recursive: true, force: true });
}
