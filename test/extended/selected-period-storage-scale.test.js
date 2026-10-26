import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { createEnergyChecksService } from '../../src/app/energy-checks-service.js';
import { energyCheckSummaries } from '../../src/app/energy-checks.js';
import { getHeatingBenefit } from '../../src/app/chart-heating-benefit.js';
import { chartRange } from '../../src/app/chart-data.js';
import { createVoltageReader, VOLTAGE_VERSION } from '../../src/storage/voltage.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const date = '2026-09-01', range = chartRange({ startDate: date, endDate: date });
const signal = 'property_import_energy_counter';
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const checkPayload = (start, end, complete = true) => ({ version: 1, source: 'easee', start, end,
  estimatedKwh: complete ? 1.1 : null, referenceKwh: complete ? 1 : null,
  complete, quality: complete ? [] : ['incomplete-coverage'] });

async function completed(service, args, checkRecording) {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    checkRecording();
    const state = await service.view(args);
    if (state.job.state === 'failed') assert.fail(JSON.stringify(state.job.error));
    if (state.job.state === 'completed') return state;
    await pause();
  }
  assert.fail('The isolated selected-period worker did not complete');
}

function seedEnergyPrefix(store, count) {
  const audit = store.db.prepare(`INSERT INTO energy_audits(source,device,signal,source_time,received_at,value,quality)
    VALUES('easee','synthetic-meter',?,?,?,0,'[]')`);
  const observation = store.db.prepare(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw)
    VALUES('easee','synthetic-meter',?,0.1,'kWh',?,?,'[]',?)`);
  const event = store.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
  for (let offset = 0; offset < count; offset += 128) store.transaction(() => {
    for (let n = offset; n < Math.min(count, offset + 128); n++) {
      const time = range.from - DAY - (count - n) * 60_000;
      audit.run(signal, time, time);
      observation.run(`property_energy_l${n % 3 + 1}`, time, time,
        JSON.stringify({ intervalStart: time - 1000, intervalEnd: time }));
      event.run('charging-session-check', JSON.stringify(checkPayload(time - 1000, time, false)), time);
    }
  });
}

test('fixed one-day Energy checks read bounded evidence across mixed retained prefixes while recording remains available', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-selected-energy-scale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metrics = [];
  let previousResult;
  for (const oldRows of [1000, 50_000]) {
    const store = new Store(join(directory, `fixture-${oldRows}.sqlite`));
    let service, heartbeat;
    const writes = [];
    try {
      seedEnergyPrefix(store, oldRows);
      const firstAt = range.from + HOUR, lastAt = range.from + 2 * HOUR;
      const energyStart = range.from - 30 * DAY, energyEnd = range.to + 5 * DAY;
      const now = energyEnd + HOUR;
      store.transaction(() => {
        for (const [time, value] of [[firstAt, 1], [lastAt, 2]]) store.energyAudit({ source: 'easee',
          device: 'synthetic-meter', signal, sourceTime: time, receivedAt: time, value });
        for (let phase = 1; phase <= 3; phase++) store.observation({ source: 'easee', device: 'synthetic-meter',
          signal: `property_energy_l${phase}`, value: (energyEnd - energyStart) / HOUR / 3, unit: 'kWh',
          sourceTime: energyEnd, receivedAt: energyEnd, quality: ['estimated'],
          raw: { intervalStart: energyStart, intervalEnd: energyEnd } });
        store.event('charging-session-check', checkPayload(firstAt, lastAt), lastAt);
      });
      const expected = energyCheckSummaries(store, { now, range });
      assert.equal(expected[0].summary.readingCount, 2);
      assert.equal(expected[0].summary.status, 'compared');
      assert(Math.abs(expected[0].summary.comparison.estimatedKwh - 1) < 1e-9,
        'The source interval crosses both selected-date boundaries and contributes only its actual overlap');
      assert.equal(expected[1].summary.recordedSessions, 1);
      await store.startWriter();
      service = createEnergyChecksService({ store });
      let beats = 0, lastBeat = performance.now(), maxHeartbeatGapMs = 0, maxAcknowledgementMs = 0;
      let pendingSave = null, recordingError = null, lastSubmittedBeat = null, peakQueue = 0;
      const historyTurns = [], acknowledgements = [];
      const began = performance.now();
      const observeQueue = () => { peakQueue = Math.max(peakQueue, store.writeQueueStatus().pending); };
      const save = origin => {
        // This controlled liveness probe keeps one unresolved save while its
        // independent heartbeat continues throughout every worker stage.
        const submittedBeat = beats, submittedAt = performance.now();
        lastSubmittedBeat = submittedBeat;
        const saving = store.runWrite(() => store.setState('synthetic:concurrent-period-check', { beat: submittedBeat }));
        pendingSave = saving; writes.push(saving); observeQueue();
        saving.then(() => {
          const acknowledgedAt = performance.now();
          maxAcknowledgementMs = Math.max(maxAcknowledgementMs, acknowledgedAt - submittedAt);
          acknowledgements.push({ origin, at: acknowledgedAt,
            releasedTurns: historyTurns.filter(turn => turn.releasedAt !== undefined).length });
          if (pendingSave === saving) pendingSave = null;
        }, error => {
          recordingError ??= error;
          if (pendingSave === saving) pendingSave = null;
        });
      };
      const runStorageTask = store.runStorageTask.bind(store);
      store.runStorageTask = (operation, options) => options?.kind !== 'history' ? runStorageTask(operation, options)
        : runStorageTask(async () => {
          const turn = { startedAt: performance.now() }; historyTurns.push(turn); observeQueue();
          // Queue a real foreground save inside a known history lease. Its
          // durable acknowledgement must precede a later actual history turn.
          if (historyTurns.length === 1) save('first-history-turn');
          try { return await operation(); }
          finally { turn.releasedAt = performance.now(); observeQueue(); }
        }, options);
      heartbeat = setInterval(() => {
        beats++;
        const tick = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, tick - lastBeat); lastBeat = tick;
        observeQueue();
        if (historyTurns.length && !pendingSave && !recordingError) save('heartbeat');
      }, 5);
      const args = { now, startDate: date, endDate: date };
      const first = await service.view(args), initialViewMs = performance.now() - began;
      assert.equal(first.result, null, 'A foreground view starts background work without synchronously copying history');
      const result = await completed(service, args, () => { if (recordingError) throw recordingError; });
      const workerCompletedAt = performance.now();
      clearInterval(heartbeat); heartbeat = null; await Promise.all(writes);
      const recordingDrainedAt = performance.now();
      if (recordingError) throw recordingError;
      const firstHistorySave = acknowledgements.find(value => value.origin === 'first-history-turn');
      assert(firstHistorySave?.releasedTurns > 0, 'The foreground save commits after the first actual history lease is released');
      assert(historyTurns.some(turn => turn.startedAt > firstHistorySave.at),
        'A later actual history lease starts after the foreground save commits, before the worker can finish');
      const commitsBetweenHistoryTurns = acknowledgements.filter(value => value.releasedTurns > 0
        && historyTurns.some(turn => turn.startedAt > value.at)).length;
      assert(commitsBetweenHistoryTurns > 0, 'Recording durably progresses between real history turns');
      assert(peakQueue <= 3, `Only one recording save, one history lease and one WAL-maintenance turn may be outstanding: ${peakQueue}`);
      // Generous synthetic Ubuntu qualification bounds; these do not claim
      // installed-device timing or hard real-time scheduling.
      assert(maxAcknowledgementMs < 2000, `Recording acknowledgement was delayed ${maxAcknowledgementMs}ms`);
      assert(maxHeartbeatGapMs < 2000, `The independent heartbeat was delayed ${maxHeartbeatGapMs}ms`);
      assert.deepEqual(result.result, expected);
      if (previousResult) assert.deepEqual(result.result, previousResult, 'Unrelated older prefixes cannot alter the selected result');
      previousResult = result.result;
      assert(result.job.processed < 512,
        `${result.job.processed} inspected source rows must stay bounded by selected evidence and its small counter guard`);
      assert(beats > 0 && writes.length > 0, 'Timers and admitted recording saves continue while the history job runs');
      assert.equal(acknowledgements.length, writes.length, 'Every submitted recording save receives its durable acknowledgement');
      assert.equal(store.getState('synthetic:concurrent-period-check').beat, lastSubmittedBeat);
      metrics.push({ oldRowsPerTable: oldRows, databaseMiB: statSync(store.path).size / 1024 ** 2,
        initialViewMs, workerMs: workerCompletedAt - began, drainMs: recordingDrainedAt - workerCompletedAt,
        processedRows: result.job.processed, concurrentWrites: writes.length, commitsBetweenHistoryTurns,
        historyTurns: historyTurns.length, peakQueue, maxAcknowledgementMs, maxHeartbeatGapMs });
      t.diagnostic(JSON.stringify(metrics.at(-1)));
    } finally {
      clearInterval(heartbeat); await Promise.allSettled(writes); await service?.close(); await store.close();
    }
  }
  assert(Math.abs(metrics[1].processedRows - metrics[0].processedRows) <= 2,
    'Increasing only unrelated retained history cannot enlarge a selected-period evidence copy');
});

test('recent Home savings seek the same long-start outcomes and selected assessments across growing older cycle archives', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-selected-benefit-scale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let previous;
  for (const oldRows of [1000, 50_000]) {
    const store = new Store(join(directory, `fixture-${oldRows}.sqlite`));
    try {
      const oldStart = range.from - 50_024 * HOUR;
      const old = store.db.prepare(`INSERT INTO learning_cycles VALUES(?,'providers',?,?,'completed',?)`);
      const assessment = { profitCents: 125, uncertaintyCents: 25, referenceCostCents: 300,
        actualSpaceHeatingCostCents: 175, basis: 'estimated-space-heating-execution-and-reference' };
      for (let offset = 0; offset < oldRows; offset += 128) store.transaction(() => {
        for (let n = offset; n < Math.min(oldRows, offset + 128); n++) {
          const startedAt = oldStart + n * HOUR, endedAt = startedAt + 1000;
          old.run(`synthetic-old-${n}`, startedAt, endedAt, JSON.stringify({ id: `synthetic-old-${n}`,
            startedAt, endedAt, status: 'completed', assessment }));
        }
      });
      const save = (id, status, startedAt, endedAt) => store.cycle('providers', { id, status, startedAt, endedAt, assessment });
      store.transaction(() => {
        save('synthetic-crossing', 'completed', oldStart, range.from + HOUR);
        save('synthetic-unassessed', 'completed', oldStart, range.from + 2 * HOUR);
        save('synthetic-incomplete', 'incomplete', oldStart, range.from + 3 * HOUR);
        save('synthetic-active', 'active', oldStart, null);
        save('synthetic-excluded', 'completed', oldStart, range.from + 4 * HOUR);
        store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','learning_cycles','synthetic-excluded')").run();
        store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','cycle_assessments','synthetic-unassessed')").run();
      });
      const before = store.checkpoint(), plans = [];
      const reader = { db: { prepare(sql) {
        const statement = store.db.prepare(sql);
        return { get(...params) {
          plans.push(store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail));
          return statement.get(...params);
        } };
      } } };
      const now = range.to + HOUR, began = performance.now();
      const result = getHeatingBenefit({ store: reader, input: 'providers', range, now });
      const elapsedMs = performance.now() - began;
      assert.deepEqual(result.counts, { assessed: 1, completed: 2, unassessed: 1, incomplete: 1, active: 1, startedBeforeSelection: 1 });
      assert.equal(result.valueEuro, 1.25); assert.equal(result.referenceCostEuro, 3); assert.equal(result.actualSpaceHeatingCostEuro, 1.75);
      assert.deepEqual(result.estimateRange, { lowerEuro: 1, upperEuro: 1.5 });
      assert.equal(result.firstStartedAt, oldStart); assert.equal(result.lastEndedAt, range.from + HOUR);
      if (previous) assert.deepEqual(result, previous);
      previous = result;
      assert.deepEqual(store.checkpoint(), before, 'The indexed chart read never mutates retained history');
      for (const plan of plans) {
        assert(plan.some(detail => /learning_cycles_completed_at.*ended_at>.*ended_at</.test(detail)), plan.join('\n'));
        assert(plan.some(detail => /learning_cycles_active_at.*input=.*started_at</.test(detail)), plan.join('\n'));
        assert(!plan.some(detail => /SCAN (?:r|learning_cycles)\b/.test(detail)));
      }
      t.diagnostic(JSON.stringify({ olderCycles: oldRows, databaseMiB: statSync(store.path).size / 1024 ** 2,
        selectedCompleted: result.counts.completed, elapsedMs }));
    } finally { store.close(); }
  }
});

test('paged voltage seeks stay bounded with an empty opposite clock cohort and preserve late-clock, ID and scope selection', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-selected-voltage-scale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const focus = range.from + HOUR, now = focus + 3 * 60_000;
  const raw = JSON.stringify({ voltageEstimate: { version: VOLTAGE_VERSION, input: 4, inputs: 4 },
    voltageSource: 'synthetic-meter', voltageAvailability: 'reporting', basis: 'time-weighted-voltage-estimate' });
  for (const oldClock of ['ordinary', 'late']) {
    let previous;
    for (const oldRows of [1000, 50_000]) {
      const store = new Store(join(directory, `fixture-${oldClock}-${oldRows}.sqlite`));
      try {
        const insert = store.db.prepare(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw)
          VALUES('voltage-estimate',?,?,?,'V',?,?,'["estimated"]',?)`);
        for (let offset = 0; offset < oldRows; offset += 128) store.transaction(() => {
          for (let n = offset; n < Math.min(oldRows, offset + 128); n++) {
            const time = range.from - DAY - (oldRows - n) * 60_000;
            insert.run(n % 2 ? 'mqtt' : 'providers', `voltage_estimate_l${n % 3 + 1}`, 225, time,
              time + (oldClock === 'late' ? 30_000 : 0), raw);
          }
        });
        const recent = (sourceTime, receivedAt, values, device = 'providers') => values.map((value, phase) =>
          Number(insert.run(device, `voltage_estimate_l${phase + 1}`, value, sourceTime, receivedAt, raw).lastInsertRowid));
        let sameClock;
        store.transaction(() => {
          recent(focus, focus, [231, 232, 233]);
          recent(focus - 2 * 60_000, focus + 60_000, [241, 242, 243]);
          sameClock = recent(focus + 60_000, focus + 60_000, [235, 236, 237], 'mqtt');
          recent(focus - 3 * 60_000, focus + 5 * 60_000, [249, 249, 249]);
          store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations',?)")
            .run(String(sameClock[1]));
        });
        const plans = [], returns = [];
        const facade = { db: { prepare(sql) {
          const statement = store.db.prepare(sql);
          return {
            get(...params) {
              plans.push({ sql, details: store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail) });
              const row = statement.get(...params); returns.push(row ? 1 : 0); return row;
            },
            *iterate(...params) {
              plans.push({ sql, details: store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail) });
              let count = 0;
              try { for (const row of statement.iterate(...params)) { count++; yield row; } }
              finally { returns.push(count); }
            },
          };
        } } };
        const paged = createVoltageReader(facade, { input: 'providers', now, pageRows: 12 });
        const native = createVoltageReader(store, { input: 'providers', now });
        const began = performance.now();
        const result = [focus, focus + 30_000, focus + 60_000, focus + 2 * 60_000, now]
          .map(time => paged(time));
        const elapsedMs = performance.now() - began;
        assert.deepEqual(result, [focus, focus + 30_000, focus + 60_000, focus + 2 * 60_000, now].map(time => native(time)));
        assert.deepEqual(result[0].voltageV, [231, 232, 233]);
        assert.deepEqual(result[2].voltageV, [235, 242, 237], 'Equal availability clocks retain ID precedence and selected exclusions');
        if (previous) assert.deepEqual(result, previous, 'Older rows in either clock cohort cannot change recent estimates');
        previous = result;
        assert.deepEqual(createVoltageReader(store, { input: 'providers', now: focus + 30_000, pageRows: 12 })(focus).voltageV,
          [231, 232, 233], 'The later receipt remains unavailable at the earlier snapshot cutoff');
        assert.deepEqual(createVoltageReader(store, { input: 'providers', now: focus + 6 * 60_000, pageRows: 12 })(focus + 5 * 60_000).voltageV,
          [249, 249, 249], 'A later snapshot may admit the original late receipt');
        assert.deepEqual(createVoltageReader(facade, { input: 'simulated', now, pageRows: 12 })(now).voltageV,
          [null, null, null], 'An absent physical scope cannot borrow the other scope\'s archive');
        const pagePlans = plans.filter(plan => plan.sql.includes('INDEXED BY observations_voltage_available'));
        assert(pagePlans.length > 0);
        assert(pagePlans.every(plan => plan.details.some(detail => /observations_voltage_available.*device=.*signal=/.test(detail))),
          'Every paged physical prefix uses its sparse availability index');
        assert(pagePlans.some(plan => plan.details.some(detail => /observations_voltage_available.*<expr>>/.test(detail))),
          'Forward windows seek the availability lower bound rather than filtering old source or receipt history');
        assert(pagePlans.every(plan => !plan.details.some(detail => /TEMP B-TREE|SCAN observations/.test(detail))));
        assert(returns.every(count => count <= 12));
        assert(plans.length < 64, 'A fixed recent lookup has a bounded number of physical-prefix queries');
        t.diagnostic(JSON.stringify({ oldClock, oldRows, elapsedMs, nativeTurns: plans.length,
          returnedRows: returns.reduce((sum, count) => sum + count, 0) }));
      } finally { store.close(); }
    }
  }
});
