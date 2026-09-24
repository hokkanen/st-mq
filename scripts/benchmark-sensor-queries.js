import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { sensorBoundaries } from '../src/app/sensor-inputs.js';
import { lastIndoorReading } from '../src/app/indoor-readings.js';

// Entirely synthetic, disposable in-memory history. No configuration, household
// database, providers or network connections are opened. Timings are descriptive;
// assertions check results, never machine-dependent wall-clock thresholds.
// Run: node scripts/benchmark-sensor-queries.js [--baseline=<git-revision>]
const options = process.argv.slice(2);
if (options.includes('--help')) {
  console.log('Usage: node scripts/benchmark-sensor-queries.js [--baseline=<git-revision>]');
  process.exit(0);
}
assert(options.length <= 1 && options.every(value => /^--baseline=[\w./-]+$/.test(value)),
  'Expected at most one --baseline=<git-revision> argument');
const baseline = options[0]?.slice('--baseline='.length);
const minute = 60_000, day = 24 * 60 * minute;
const now = Date.parse('2026-09-20T12:00:00Z'), contextAt = now - 400 * day;
const input = 'mqtt', signal = 'indoor_temperature', repetitions = 3;
const expectedBoundaries = { indoor_temperature: contextAt, bedroom_temperature: contextAt + 1,
  garage_temperature: contextAt + 2, outdoor_temperature: contextAt + 3 };
const rounded = value => Math.round(value * 1000) / 1000;

async function historicalModule(path, revision) {
  const text = execFileSync('git', ['show', `${revision}:${path}`],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  // Preserve relative dependencies when evaluating the two old query modules.
  // This compares query implementations against the same current schema/data.
  const base = new URL(`../${path}`, import.meta.url);
  const absolute = text.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_match, prefix, relative, suffix) => `${prefix}${new URL(relative, base).href}${suffix}`);
  return import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`);
}

function fixture({ samples, spans }) {
  const store = new Store(':memory:');
  try {
    store.transaction(() => {
      const context = value => store.appendLearningJournal(input, { kind: 'context', at: value.at,
        key: value.key, algorithmVersion: 'synthetic-sensor-benchmark', payload: { value: value.payload } });
      for (const [name, at] of Object.entries(expectedBoundaries))
        context({ at, key: `original-${name}`, payload: { sensorChange: { signal: name } } });
      // Bulk insertion avoids measuring repeated API validation during fixture
      // construction. All rows have invented data and the real journal schema.
      const insert = store.db.prepare(`INSERT INTO learning_journal_entries
        (epoch,input,key,kind,at,algorithm_version,payload) VALUES('original',?,?,'sample',?,?,?)`);
      const payload = JSON.stringify({ value: { indoorC: 21, outdoorC: 5, quality: [], synthetic: true } });
      const inputs = [input, 'garage:mqtt', 'history'];
      for (let index = 0; index < samples; index++)
        insert.run(inputs[index % inputs.length], `synthetic-sample-${index}`, contextAt + 10 + index,
          'synthetic-sensor-benchmark', payload);
      // Put a real reversal after the unrelated samples so its revision is high.
      // The old correlated lookup scanned that archive for each sensor change.
      const replaced = context({ at: contextAt + day, key: 'replacement',
        payload: { sensorChange: { signal } } });
      context({ at: contextAt + 2 * day, key: 'reversal', payload: { sensorRevert: { id: replaced } } });

      const recorder = new Recorder(store);
      for (let index = 0; index < spans; index++) {
        // Reports spaced beyond the 75-minute deadline establish separate spans
        // and genuine gaps. Changing values also saves original observations.
        const at = now - minute - (spans - 1 - index) * 90 * minute;
        recorder.record({ source: 'mqtt-temperature', device: 'synthetic-benchmark-room', signal,
          sourceTime: at, receivedAt: at, value: 20 + index % 2, unit: 'degC', quality: [],
          raw: { reportIntervalMs: 60 * minute, reportGraceMs: 15 * minute } });
      }
    });
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM recorder_coverage').get().count, spans);
    return store;
  } catch (error) { store.close(); throw error; }
}

function measure(query, check) {
  const times = [];
  let result;
  for (let repeat = 0; repeat < repetitions; repeat++) {
    const started = performance.now();
    result = query();
    times.push(performance.now() - started);
    check(result);
  }
  return { firstMs: rounded(times[0]), medianMs: rounded([...times].sort((a, b) => a - b)[1]),
    maxMs: rounded(Math.max(...times)) };
}

const implementations = [{ name: 'working-tree', sensorBoundaries, lastIndoorReading }];
if (baseline) {
  const boundaries = await historicalModule('src/app/sensor-inputs.js', baseline);
  const readings = await historicalModule('src/app/indoor-readings.js', baseline);
  implementations.push({ name: `baseline:${baseline}`, sensorBoundaries: boundaries.sensorBoundaries,
    lastIndoorReading: readings.lastIndoorReading });
}
const report = { host: `${process.platform}/${process.arch}`, node: process.version, repetitions,
  note: 'Synthetic in-memory query timings; no browser, disk, network or Raspberry Pi measurement. Baselines use the current schema.',
  expected: { boundaries: expectedBoundaries, latestValue: 21, latestSourceTime: now - minute,
    latestReportAvailable: true, earlierReportGapStale: true }, fixtures: [] };
for (const size of [{ name: 'small', samples: 1000, spans: 30 },
  { name: 'large', samples: 725_000, spans: 3000 }]) {
  const started = performance.now(), store = fixture(size);
  try {
    const row = { ...size, setupMs: rounded(performance.now() - started), implementations: [] };
    for (const implementation of implementations) {
      const request = { input, signal, at: now, notBefore: contextAt };
      const checkReading = reading => {
        assert.equal(reading?.value, 21);
        assert.equal(reading.sourceTime, now - minute);
        assert.equal(reading.receivedAt, now - minute);
      };
      const timings = {
        name: implementation.name,
        sensorBoundaries: measure(() => implementation.sensorBoundaries(store, input, now),
          result => assert.deepEqual(result, expectedBoundaries)),
        lastIndoorReading: measure(() => implementation.lastIndoorReading(store, request), result => {
          checkReading(result);
          assert.equal(result.stale, false);
          assert.equal(result.reportCoverage.available, true);
        }),
        existenceOnly: measure(() => implementation.lastIndoorReading(store,
          { ...request, includeAvailability: false }), checkReading),
      };
      const gap = implementation.lastIndoorReading(store, { ...request, at: now - 10 * minute });
      assert.equal(gap.value, 20);
      assert.equal(gap.stale, true, 'A later report must not erase the preceding genuine gap');
      row.implementations.push(timings);
    }
    report.fixtures.push(row);
  } finally { store.close(); }
}
console.log(JSON.stringify(report, null, 2));
