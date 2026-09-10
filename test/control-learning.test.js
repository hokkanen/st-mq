import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCheckpoint, updateLearning, restoreCheckpoint, fitModel, inferComfortReference,
  validateModel, hasValidatedEnergy, MAX_SAMPLES } from '../src/control/index.js';

const HOUR = 3_600_000, start = Date.parse('2026-08-01T00:00:00Z');
const iso = value => new Date(value).toISOString();
function trajectories(count = 240, { metered = false, mode = 'mixed' } = {}) {
  let indoorC = 21;
  return Array.from({ length: count }, (_, i) => {
    const outdoorC = 6 + 8 * Math.sin(i / 15);
    const action = mode === 'normal' || i % 12 < 8 ? 'normal' : 'reduction';
    const sample = { timestamp: iso(start + i * HOUR), indoorC, outdoorC, action, regime: 'occupied' };
    if (metered) Object.assign(sample, { heatPumpElectricKw: action === 'normal' ? 3 : 0.4,
      auxiliaryElectricKw: 0.1, energyVerified: true });
    indoorC += 0.015 * (outdoorC - indoorC) + (action === 'normal' ? 0.4 : 0.04);
    return sample;
  });
}
function plateau(count = 30, temperature = 21, startAt = start) {
  return Array.from({ length: count }, (_, i) => ({ timestamp: iso(startAt + i * HOUR),
    indoorC: temperature + (i % 2 ? 0.02 : -0.02), outdoorC: 5, action: 'normal', regime: 'occupied' }));
}

test('chronological model learns an independently specified trajectory with bounded holdout error', () => {
  const samples = trajectories();
  const result = fitModel(samples);
  assert.equal(result.accepted, true, result.reason);
  assert.ok(validateModel(result.model));
  assert.ok(Math.abs(result.model.parameters.lossPerHour - 0.015) < 0.001);
  assert.ok(Math.abs(result.model.parameters.normalHeatCPerHour - 0.4) < 0.01);
  assert.ok(Math.abs(result.model.parameters.reducedHeatCPerHour - 0.04) < 0.01);
  assert.equal(result.model.validation.chronological, true);
  assert.ok(Date.parse(result.model.validation.trainThrough) <= Date.parse(result.model.validation.validateFrom));
  assert.ok(result.model.validation.maeCPerHour < 0.01);
  assert.equal(hasValidatedEnergy(result.model), false);
});

test('energy estimates require explicitly verified heat-pump observations', () => {
  const result = fitModel(trajectories(240, { metered: true }));
  assert.equal(result.accepted, true);
  assert.equal(hasValidatedEnergy(result.model), true);
  const uncertain = trajectories(240, { metered: true });
  for (const sample of uncertain) { sample.energyVerified = false; sample.gridImportKw = 20; sample.evChargingKw = 11; }
  assert.equal(fitModel(uncertain).model.energy, null);
});

test('absence and unidentifiable all-normal histories cannot establish setback model', () => {
  assert.equal(fitModel(trajectories(200, { mode: 'normal' })).accepted, false);
  const samples = trajectories();
  for (const sample of samples) sample.regime = 'absence';
  assert.equal(fitModel(samples).reason, 'insufficient-transitions');
});

test('incremental processing is idempotent and checkpoint history stays bounded', () => {
  const samples = trajectories(1500);
  let checkpoint = emptyCheckpoint();
  for (let i = 0; i < samples.length; i += 100) checkpoint = updateLearning(checkpoint, samples.slice(i, i + 100), { now: start + 1600 * HOUR });
  assert.ok(checkpoint.samples.length <= MAX_SAMPLES);
  assert.equal(checkpoint.processedThrough, samples.at(-1).timestamp);
  const duplicate = updateLearning(checkpoint, samples.slice(-100), { now: start + 1600 * HOUR });
  assert.equal(duplicate.samples.length, checkpoint.samples.length);
  assert.equal(duplicate.processedThrough, checkpoint.processedThrough);
  assert.equal(duplicate.health.accepted, checkpoint.health.accepted);
  assert.throws(() => updateLearning(checkpoint, samples), RangeError);
});

test('corrupt/incompatible checkpoints rebuild and a degraded model rolls back', () => {
  assert.equal(restoreCheckpoint('{broken').health.status, 'rebuilding');
  assert.equal(restoreCheckpoint({ version: 999 }).health.status, 'rebuilding');
  const good = fitModel(trajectories()).model;
  const checkpoint = emptyCheckpoint(); checkpoint.previousModel = good;
  checkpoint.model = { ...good, parameters: { ...good.parameters, lossPerHour: -4 } };
  const restored = restoreCheckpoint(checkpoint, { now: start + 240 * HOUR });
  assert.equal(restored.health.status, 'rolled-back');
  assert.deepEqual(restored.model, good);
});

test('parameters survive downtime while the current thermal-state estimate expires', () => {
  const samples = trajectories();
  const checkpoint = updateLearning(emptyCheckpoint(), samples, { now: start + 239 * HOUR });
  assert.ok(checkpoint.model);
  const restored = restoreCheckpoint(checkpoint, { now: start + 260 * HOUR });
  assert.ok(restored.model);
  assert.equal(restored.thermalState, null);
  assert.equal(restored.processedThrough, samples.at(-1).timestamp);
});

test('bad observations, duplicates and future data do not overwrite processed state', () => {
  const samples = trajectories(30);
  const checkpoint = updateLearning(null, samples, { now: start + 29 * HOUR });
  const bad = [{ ...samples.at(-1), timestamp: iso(start + 30 * HOUR), indoorC: 0 },
    { ...samples.at(-1), timestamp: iso(start + 31 * HOUR), quality: 'bad' },
    { ...samples.at(-1), timestamp: iso(start + 32 * HOUR) }];
  const result = updateLearning(checkpoint, bad, { now: start + 31 * HOUR });
  assert.equal(result.processedThrough, iso(start + 31 * HOUR));
  assert.equal(result.samples.length, samples.length + 2);
  assert.equal(result.thermalState, null);
  assert.ok(result.samples.slice(-2).every(sample => sample.kind === 'continuity-barrier'));
});

test('a changed chronological holdout rejects a poor fit while keeping the prior checkpoint model', () => {
  const samples = trajectories(240);
  const first = fitModel(samples);
  assert.equal(first.accepted, true);
  const changed = samples.map((sample, i) => i >= 168 ? { ...sample, indoorC: sample.indoorC + ((i % 2) ? 0.6 : -0.6) } : sample);
  const candidate = fitModel(changed, first.model);
  assert.equal(candidate.accepted, false);
});

test('comfort reference comes from achieved occupied normal plateau and defaults to no guessed target', () => {
  assert.equal(inferComfortReference(null, [], { now: start }), null);
  const samples = plateau();
  const reference = inferComfortReference(null, samples, { now: start + 29 * HOUR });
  assert.equal(reference.targetC, 21);
  assert.equal(reference.source, 'sustained-occupied-normal-temperature-plateau');
  assert.ok(reference.samples >= 25);
  const checkpoint = updateLearning(emptyCheckpoint(), samples, { now: start + 29 * HOUR });
  assert.equal(checkpoint.comfortReference.targetC, 21);
});

test('reference cannot be learned from absence, setback, preheat, recovery, gaps or continuing cooling', () => {
  for (const mutate of [samples => { for (const sample of samples) sample.regime = 'absence'; },
    samples => { for (const sample of samples) delete sample.regime; },
    samples => { samples[20].action = 'reduction'; },
    samples => { samples[20].preheat = true; },
    samples => { samples[20].recovering = true; },
    samples => { samples[20].roomBoostC = 1; },
    samples => { samples[20].inputSegments = [{ phase: 'reduction', regime: 'occupied', roomBoostC: 0 }]; },
    samples => { samples.splice(18, 4); },
    samples => { for (let i = 0; i < samples.length; i++) samples[i].indoorC -= i * 0.08; }]) {
    const samples = plateau(); mutate(samples);
    assert.equal(inferComfortReference(null, samples, { now: start + 29 * HOUR }), null);
  }
});

test('one later plateau cannot reset the reference in either direction and preheat remains excluded', () => {
  const reference = inferComfortReference(null, plateau(), { now: start + 29 * HOUR });
  const lower = plateau(30, 19, start + 30 * HOUR);
  assert.equal(inferComfortReference(reference, lower, { now: start + 59 * HOUR }).targetC, reference.targetC);
  const preheat = plateau(30, 23, start + 30 * HOUR).map(sample => ({ ...sample, preheat: true }));
  assert.deepEqual(inferComfortReference(reference, preheat, { now: start + 59 * HOUR }), reference);
  const higher = plateau(30, 21.6, start + 30 * HOUR);
  assert.equal(inferComfortReference(reference, higher, { now: start + 59 * HOUR }).targetC, reference.targetC);
});

function dailyNormalHistory(temperature, days = 6) {
  return [...plateau(), ...Array.from({ length: days * 24 }, (_, i) => {
    const phase = i % 24 < 2 ? 'preheat' : i % 24 < 4 ? 'reduction' : i % 24 < 6 ? 'recovery' : 'normal';
    return { timestamp: iso(start + (30 + i) * HOUR), indoorC: temperature, outdoorC: 5,
      regime: 'occupied', action: phase === 'normal' ? 'normal' : 'reduction',
      preheat: phase === 'preheat', recovering: phase === 'recovery' };
  })];
}

test('repeated normal plateaus across daily cycles gradually learn both lower and higher household settings', () => {
  for (const temperature of [19, 23]) {
    const samples = dailyNormalHistory(temperature);
    let reference = null, firstChange = null;
    for (let i = 0; i < samples.length; i++) {
      const previous = reference;
      reference = inferComfortReference(reference, samples.slice(0, i + 1), { now: samples[i].timestamp });
      if (!previous) continue;
      if (samples[i].action !== 'normal') assert.equal(reference.targetC, previous.targetC);
      if (reference.targetC !== previous.targetC) {
        firstChange ??= i;
        assert.ok(Math.abs(reference.targetC - previous.targetC) <= 0.200000001);
        assert.ok(Math.abs(reference.targetC - temperature) < Math.abs(previous.targetC - temperature));
      }
      assert.deepEqual(inferComfortReference(reference, samples.slice(0, i + 1), { now: samples[i].timestamp }), reference,
        'A repeated window earns no temperature adjustment');
    }
    assert.ok(firstChange >= 30 + 48, 'The new setting requires evidence across multiple days');
    assert.ok(Math.abs(reference.targetC - 21) > 0.4 && Math.abs(reference.targetC - 21) < 1);
  }
});

test('cooler controller phases never lower a normal-temperature reference', () => {
  const samples = dailyNormalHistory(21).map(sample => sample.action === 'normal' ? sample : { ...sample, indoorC: 18 });
  let reference = null;
  for (let i = 0; i < samples.length; i++) reference = inferComfortReference(reference, samples.slice(0, i + 1), { now: samples[i].timestamp });
  assert.equal(reference.targetC, 21);
});

test('away, missing and fireplace observations clear pending plateau evidence before it can adjust the reference', () => {
  for (const barrier of [{ regime: 'absence' }, { quality: ['missing'] }, { fireplaceActive: true }]) {
    const samples = dailyNormalHistory(19, 2);
    let reference = null;
    for (let i = 0; i < samples.length; i++) reference = inferComfortReference(reference, samples.slice(0, i + 1), { now: samples[i].timestamp });
    assert.ok(reference.adaptation.evidenceHours >= 24);
    assert.equal(reference.targetC, 21);
    samples.push({ ...samples.at(-1), timestamp: iso(start + samples.length * HOUR), ...barrier });
    reference = inferComfortReference(reference, samples, { now: samples.at(-1).timestamp });
    assert.equal(reference.targetC, 21);
    assert.equal(reference.adaptation, null);
  }
});

test('comfort adaptation is independent of historical page boundaries and survives restart', () => {
  const samples = dailyNormalHistory(19, 5), now = samples.at(-1).timestamp;
  const batch = updateLearning(null, samples, { now });
  let single = null;
  for (const sample of samples) single = updateLearning(single, [sample], { now: sample.timestamp });
  assert.deepEqual(batch.comfortReference, single.comfortReference);
  let paged = updateLearning(null, samples.slice(0, 78), { now });
  paged = restoreCheckpoint(JSON.stringify(paged), { now });
  paged = updateLearning(paged, samples.slice(78), { now });
  assert.deepEqual(paged.comfortReference, single.comfortReference);
});

test('old plateau evidence expires after a long gap and held old rows cannot earn fresh credit', () => {
  const samples = dailyNormalHistory(19, 2);
  let reference = null;
  for (let i = 0; i < samples.length; i++) reference = inferComfortReference(reference, samples.slice(0, i + 1), { now: samples[i].timestamp });
  const oldEnd = Date.parse(samples.at(-1).timestamp);
  assert.deepEqual(inferComfortReference(reference, samples, { now: oldEnd + 24 * HOUR }), reference);
  const resumed = plateau(9, 19, oldEnd + 72 * HOUR);
  reference = inferComfortReference(reference, [...samples, ...resumed], { now: resumed.at(-1).timestamp });
  assert.equal(reference.targetC, 21);
  assert.equal(reference.adaptation.evidenceHours, 6);
  assert.ok(Date.parse(reference.adaptation.firstWindowStart) > oldEnd);
});

test('a passive summer plateau cannot establish or inflate the household heating reference', () => {
  const warm = plateau(30, 23).map(sample => ({ ...sample, outdoorC: 21 }));
  assert.equal(inferComfortReference(null, warm, { now: start + 29 * HOUR }), null);
  const reference = inferComfortReference(null, plateau(), { now: start + 29 * HOUR });
  const laterWarm = warm.map(sample => ({ ...sample, timestamp: iso(Date.parse(sample.timestamp) + 30 * HOUR) }));
  assert.deepEqual(inferComfortReference(reference, laterWarm, { now: start + 59 * HOUR }), reference);
});

test('cool-weather inference records its provisional heat-demand evidence without requiring an energy meter', () => {
  const reference = inferComfortReference(null, plateau(), { now: start + 29 * HOUR });
  assert.equal(reference.version, 3);
  assert.equal(reference.heatingEvidence.kind, 'sustained-cool-weather-proxy');
  assert.equal(reference.confidence, 'provisional-heating-demand-baseline');
  assert.ok(reference.heatingEvidence.meanOutdoorC <= 10);
  assert.ok(reference.heatingEvidence.meanIndoorOutdoorGapC >= 10);
});

test('verified repeated space-heating activity can support a mild-weather baseline', () => {
  const samples = plateau().map((sample, i) => ({ ...sample, outdoorC: 14,
    heating: { verified: true, compressorActive: i % 2 === 0, route: 'space-heating' } }));
  const reference = inferComfortReference(null, samples, { now: start + 29 * HOUR });
  assert.equal(reference?.targetC, 21);
  assert.equal(reference.heatingEvidence.kind, 'verified-space-heating-activity');
  assert.equal(reference.confidence, 'observed-heating-baseline');
  for (const sample of samples) sample.heating.verified = false;
  assert.equal(inferComfortReference(null, samples, { now: start + 29 * HOUR }), null);
});

test('DHW operation and verified inactive compressor observations do not prove heating demand', () => {
  for (const heating of [{ verified: true, compressorActive: true, route: 'dhw' },
    { verified: true, compressorActive: false, route: 'space-heating' }]) {
    const samples = plateau().map(sample => ({ ...sample, heating }));
    assert.equal(inferComfortReference(null, samples, { now: start + 29 * HOUR }), null);
  }
});

test('bad array-quality readings break baseline continuity through incremental processing and restart', () => {
  const samples = plateau();
  samples[20].quality = ['unknown-source-time'];
  let checkpoint = updateLearning(null, samples.slice(0, 21), { now: start + 20 * HOUR });
  assert.equal(checkpoint.comfortReference, null);
  checkpoint = restoreCheckpoint(JSON.stringify(checkpoint), { now: start + 21 * HOUR });
  checkpoint = updateLearning(checkpoint, samples.slice(21), { now: start + 29 * HOUR });
  assert.equal(checkpoint.comfortReference, null);
  assert.equal(checkpoint.samples[20].kind, 'continuity-barrier');
});

test('invalid readings cannot be bridged to invent thermal model transitions', () => {
  const samples = trajectories(100);
  for (let i = 1; i < samples.length; i += 2) samples[i].quality = ['missing'];
  const checkpoint = updateLearning(null, samples, { now: start + 99 * HOUR });
  assert.equal(checkpoint.model, null);
  assert.equal(checkpoint.health.reason, 'insufficient-transitions');
});

test('the chronological holdout starts after a full-day embargo and unordered samples are rejected', () => {
  const samples = trajectories();
  const result = fitModel(samples);
  assert.equal(result.accepted, true);
  assert.ok(Date.parse(result.model.validation.validateFrom) - Date.parse(result.model.validation.trainThrough) >= 24 * HOUR);
  assert.equal(fitModel([...samples].reverse()).reason, 'nonchronological-input');
});

test('old checkpoint/reference inference rules force a rebuild instead of retaining a summer target', () => {
  const old = { ...emptyCheckpoint(), version: 1, comfortReference: { version: 1, targetC: 22.9 } };
  const restored = restoreCheckpoint(old);
  assert.equal(restored.comfortReference, null);
  assert.equal(restored.health.reason, 'incompatible-checkpoint');
});

test('rejected candidate validation cannot report accepted in learning health', () => {
  const samples = trajectories();
  const previous = fitModel(samples).model;
  const shiftedTraining = samples.map((sample, i) => i < 168 ? { ...sample, indoorC: sample.indoorC + 3 } : sample);
  const result = fitModel(shiftedTraining, previous);
  assert.equal(result.reason, 'holdout-degraded');
  assert.equal(result.validation.accepted, false);
});
