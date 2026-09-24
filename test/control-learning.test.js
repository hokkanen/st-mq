import test from 'node:test';
import assert from 'node:assert/strict';
import { inferComfortReference } from '../src/control/learning.js';
import { updateAdaptiveLearningBatch, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
const HOUR = 3_600_000, start = Date.parse('2026-08-01T00:00:00Z');
const iso = value => new Date(value).toISOString();
const emptyCheckpoint = () => restoreAdaptiveCheckpoint(null);
const restoreCheckpoint = input => restoreAdaptiveCheckpoint(input);
const updateLearning = (checkpoint, samples, options) => updateAdaptiveLearningBatch(checkpoint,
  samples.map(sample => ({ ...sample, phase: sample.action, regime: sample.regime === 'occupied' ? 'occupied' : 'away' })), options);
function plateau(count = 30, temperature = 21, startAt = start) {
  return Array.from({ length: count }, (_, i) => ({ timestamp: iso(startAt + i * HOUR),
    indoorC: temperature + (i % 2 ? 0.02 : -0.02), outdoorC: 5, action: 'normal', regime: 'occupied' }));
}

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
  assert.equal(checkpoint.samples[20].valid, false);
});
